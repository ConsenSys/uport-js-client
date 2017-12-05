// Normalize library use, which dependencies/utils do we prefer
const { decodeToken, createUnsignedToken, SECP256K1Client, TokenSigner } = require('jsontokens')
const Transaction = require('ethereumjs-tx')
const util = require('ethereumjs-util')
const BN = util.BN
const txutils = require('eth-signer/dist/eth-signer-simple.js').txutils
const EthJS = require('ethjs-query');
const HttpProvider = require('ethjs-provider-http');
const UportLite = require('uport-lite')
const verifyJWT = require('uport').JWT.verifyJWT
const nets = require('nets')
const Contract = require('uport').Contract
const ethutil = require('ethereumjs-util')
const base58 = require('bs58')
const decodeEvent = require('ethjs-abi').decodeEvent
const SecureRandom = require('secure-random')
const IPFS = require('ipfs-mini');

const tryRequire = (path) => {
  try {
    return require(path)
  } catch(err) {
    return null
  }
}

const IdentityManagerArtifact = tryRequire('./contracts/IdentityManager.json')
const RegistryArtifact = tryRequire('./contracts/UportRegistry.json')

const networks = {
  'mainnet':   {  id: '0x1',
                  registry: '0xab5c8051b9a1df1aab0149f8b0630848b7ecabf6',
                  rpcUrl: 'https://mainnet.infura.io' },
  'ropsten':   {  id: '0x3',
                  registry: '0x41566e3a081f5032bdcad470adb797635ddfe1f0',
                  rpcUrl: 'https://ropsten.infura.io' },
  'kovan':     {  id: '0x2a',
                  registry: '0x5f8e9351dc2d238fb878b6ae43aa740d62fc9758',
                  rpcUrl: 'https://kovan.infura.io' },
  'rinkeby':   {  id: '0x4',
                  registry: '0x2cc31912b2b0f3075a87b3640923d45a26cef3ee',
                  rpcUrl: 'https://rinkeby.infura.io' }
}

const DEFAULTNETWORK = 'rinkeby'

const configNetwork = (net = DEFAULTNETWORK) => {
  if (typeof net === 'object') {
    ['id', 'rpcUrl'].forEach((key) => {
      if (!net.hasOwnProperty(key)) throw new Error(`Malformed network config object, object must have '${key}' key specified.`)
    })
    if (!net.registry && RegistryArtifact.networks[net.id])  net.registry = RegistryArtifact.networks[net.id].address
    if (!net.registry) throw new Error(`Malformed network config object, no registry specified and no registry available in registry contract artifact`)
    return net
  } else if (typeof net === 'string') {
    if (!networks[net]) throw new Error(`Network configuration not available for '${net}'`)
    return networks[net]
  }

  throw new Error(`Network configuration object or network string required`)
}


const getUrlParams = (url) => (
  url.match(/[^&?]*?=[^&?]*/g)
     .map((param) => param.split('='))
     .reduce((params, param) => {
       params[param[0]] = param[1]
       return params
     }, {}))

const  funcToData = (funcStr) => {
  const name = funcStr.match(/.*\(/g)[0].slice(0, -1)
  const [type, args] = funcStr.match(/\(.*\)/g)[0].slice(1, -1).split(',')
                         .map((str) => str.trim().split(' '))
                         .reduce((arrs, param) => {
                           arrs[0].push(param[0])
                           arrs[1].push(param[1])
                           return arrs
                         }, [[],[]])
  return txutils._encodeFunctionTxData(name, type, args)
}

const intersection = (obj, arr) => Object.keys(obj).filter(key => arr.includes(key))
const filterCredentials = (credentials, keys) => [].concat.apply([], keys.map((key) => credentials[key].map((cred) => cred.jwt)))


// TODO what are the defaults here, maybe testRPC with not ipfs or infura ipfs ?, right now its rinkeby
// how to add now network? Consider having some default wrappers that setup some useful configurations
// Remove many of the conditionals and simply allow mock modules to turn actually client into test client
class UPortMockClient {
  constructor(config = {}, initState = {}) {
    this.privateKey = config.privateKey || '278a5de700e29faae8e40e366ec5012b5ec63d36ec77e8a2417154cc1d25383f'
    this.publicKey = SECP256K1Client.derivePublicKey(this.privateKey)
    this.address = config.address|| '0x3b2631d8e15b145fd2bf99fc5f98346aecdc394c'
    this.nonce = config.nonce || 0

    // Handle this differently once there is a test and full client
    this.postRes = config.postRes || false

    // TODO move init state elsewhere
    // {key: value, ...}
    this.info  = initState.info || { name: 'John Ether'  }
    // this.credentials = {address: [{jwt: ..., json: ....}, ...], ...}
    this.credentials = initState.credentials || { phone: [{ jwt: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NksifQ.eyJzdWIiOiIweDExMjIzMyIsImNsYWltIjp7ImVtYWlsIjoiYmluZ2JhbmdidW5nQGVtYWlsLmNvbSJ9LCJleHAiOjE0ODUzMjExMzQ5OTYsImlzcyI6IjB4MDAxMTIyIiwiaWF0IjoxNDg1MzIxMTMzOTk2fQ.-mEzVMPYnzqFhOr0O7fs71-dWAacnllVyOdWQY0zh2ZdIt7-30IYTewds4tGlkLmMky-Y1ZjRmIsxmM7xvAgxg',
                                    json: { "sub": '0x3b2631d8e15b145fd2bf99fc5f98346aecdc394c',
                                            "claim": { 'phone': '123-456-7891' },
                                            "exp": 1485321134996,
                                            "iss": '0x5b0abbd37bcebb98a390445b540115f3c819a3b9',
                                            "iat": 1485321133996
                                           }}]}
    const tokenSigner = new TokenSigner('ES256k', this.privateKey)
    this.signer = tokenSigner.sign.bind(tokenSigner)

     this.network = config.network ? configNetwork(config.network) : null

     if (this.network) {
       // Eventually consume an ipfs api client or at least some wrapper that allows a mock to be passed in
       this.ipfsUrl = config.ipfsConfig || 'https://ipfs.infura.io/ipfs/'
       this.registryNetwork = {[this.network.id]: {registry: this.network.registry, rpcUrl: this.network.rpcUrl}}
       const registry = config.registry || new UportLite({networks: this.registryNetwork, ipfsGw: this.ipfsUrl})
      //  TODO change this in uport-js or in uport-lite, should not be necessary
       this.registry = (address) => new Promise((resolve, reject) => {
              registry(address, (error, profile) => {
                if (error) return reject(error)
                resolve(profile)
              })
            })

      this.verifyJWT = (jwt) => verifyJWT({registry: this.registry}, jwt)

      this.provider = config.provider || new HttpProvider(this.network.rpcUrl)
      this.ethjs = config.provider ? new EthJS(this.provider) : null;
    }
  }

  sign(payload) {
    const hash = SECP256K1Client.createHash(payload)
    return SECP256K1Client.signHash(hash, this.privateKey)
  }

  addProfileKey(key, value ) {
    this.info[key] = value
  }

  returnResponse(res, url){
    return new Promise((resolve, reject) => {
      if (this.postRes) {
        nets({
          body: res,
          url: url,
          method: "POST",
          headers: { "Content-Type": "application/json" }
        }, (err, resp, body) => {
          if (err) reject(err)
          resolve(res)
        })
      }
      resolve(res)
    })
  }

  // consume(uri, actions)   actions = ['accept', 'cancel', etc], returns promise to allow for net req options
  consume(uri, actions) {
    return new Promise((resolve, reject) => {
      const params = getUrlParams(uri)
      let response

      if (!!uri.match(/:me\?.*requestToken/g)) {
        // A shareReq in a token
        const token = decodeToken(params.requestToken).payload
        const verified = filterCredentials(this.credentials, intersection(this.credentials, token.requested) )
        const req = params.requestToken
        const info = intersection(this.info, token.requested)
                     .reduce((infoReq, key) => {
                       infoReq[key] = this.info[key]
                       return infoReq
                      }, {})
        const payload = {...info, iss: this.address, iat: new Date().getTime(), verified, type: 'shareReq', req}
        response = this.signer(payload)

        if (this.network) {
          this.verifyJWT(token).then(() => resolve(response)).catch(reject)
        }

        this.returnResponse(response, token.callbackUrl).then(resolve, reject)

      } else if (!!uri.match(/:me\?/g)) {
        // A simple request
        response = this.signer({iss: this.address, iat: new Date().getTime(), address: this.address})
        this.returnResponse(txHash, params.callback_url).then(resolve, reject)

      } else if (!!uri.match(/:0[xX][0-9a-fA-F]+\?/g)) {
        // Transaction signing request
        const to = uri.match(/0[xX][0-9a-fA-F]+/g)[0]
        const data = params.bytecode || params.function ? funcToData(params.function) : '0x' //TODO whats the proper null value?
        const nonce = this.nonce++
        const value = params.value
        const gas = params.gas ? params.gas : new BN('43092000') // TODO What to default?
        const gasPrice = new BN('20000000000')
        const txObj = {to, value, data, gas, gasPrice, nonce, data}
        const tx = new Transaction(txObj)
        tx.sign(new Buffer(this.privateKey, 'hex'))

        // If given provider send tx to network
        if (this.ethjs) {
          const rawTx = util.bufferToHex(tx.serialize())
          this.ethjs.sendRawTransaction(rawTx).then(resolve, reject)
        } else {
          const txHash = util.bufferToHex(tx.hash(true))
          resolve(txHash)
          this.returnResponse(txHash, params.callback_url).then(resolve, reject)
        }

      } else if (!!uri.match(/add\?/g)) {
        // Add attestation request
        const attestations = params.attestations.isArray() ? params.attestations : [params.attestations]

        for (jwt in attestations) {
          const json = decodeToken(jwt).payload
          const key = Object.keys(json.claim)[0]

          if (this.network) {
            this.verifyJWT(jwt).then(() => {
              this.credentials[key] ? this.credentials[key].append({jwt, json}) : this.credentials[key] = [{jwt, json}]
            }).catch(reject)
          }

          // redundant
          this.credentials[key] ? this.credentials[key].append({jwt, json}) : this.credentials[key] = [{jwt, json}]
        }
        // TODO what is the response here? is there one, add proper reject failure, or don't reject pass proper response

      } else {
        // Not a valid request
        reject(new Error('Invalid URI Passed'))
        //TODO  what is our error returns from mobile? do we do anything? if not this should maybe throw instead of return error?
      }
    })
  }
}
