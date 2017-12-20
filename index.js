// Normalize library use, which dependencies/utils do we prefer
const { decodeToken, createUnsignedToken, SECP256K1Client, TokenSigner } = require('jsontokens')
const derToJose = require('jsontokens/lib/cryptoClients/ecdsaSigFormatter.js').derToJose
const createHash = SECP256K1Client.createHash
const Transaction = require('ethereumjs-tx')
const ethutil = require('ethereumjs-util')
const BN = ethutil.BN
const txutils = require('eth-signer/dist/eth-signer-simple.js').txutils
const EthJS = require('ethjs-query');
const HttpProvider = require('ethjs-provider-http');
const UportLite = require('uport-lite')
const verifyJWT = require('uport').JWT.verifyJWT
const nets = require('nets')
const Contract = require('uport').Contract
const base58 = require('bs58')
const decodeEvent = require('ethjs-abi').decodeEvent
const SecureRandom = require('secure-random')
const IPFS = require('ipfs-mini');
const EthSigner = require('eth-signer')
const IMProxySigner = EthSigner.signers.IMProxySigner
const urlDecode = require('urldecode')
const secp256k1 = ethutil.secp256k1;
const ECSignature = require('elliptic/lib/elliptic/ec/signature.js');
const base64url = require('base64url')



const tryRequire = (path) => {
  try {
    return require(path)
  } catch(err) {
    return null
  }
}

const uportIdentity = require('uport-identity')
const RegistryArtifact = require('uport-registry')
const IdentityManagerArtifact = uportIdentity.IdentityManager.v1

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
    ['id', 'registry', 'rpcUrl'].forEach((key) => {
      if (!net.hasOwnProperty(key)) throw new Error(`Malformed network config object, object must have '${key}' key specified.`)
    })
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
  return `0x${txutils._encodeFunctionTxData(name, type, args)}`
}

const intersection = (obj, arr) => Object.keys(obj).filter(key => arr.includes(key))
const filterCredentials = (credentials, keys) => [].concat.apply([], keys.map((key) => credentials[key].map((cred) => cred.jwt)))

const SimpleResponseHandler = (res, url) => new Promise((resolve, reject) => resolve(res))

const HTTPResponseHandler = (res, url) => {
    // Chasqui specific
    if (!!url.match(/chasqui.uport.me/g)) {
      return new Promise((resolve, reject) => {
        nets({
          uri: urlDecode(url),
          json: true,
          method: 'GET',
          withCredentials: false,
          rejectUnauthorized: false
        }, (err, resp, body) => {
          if (err) reject(err)
          post(res, url).then(resolve, reject)
        })
      })
    }
    return post(res, url)
  }

const post = (res, url) => new Promise((resolve, reject) => {
  nets({
    body: JSON.stringify({access_token: res}),
    url: urlDecode(url),
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json; charset=utf-8'
    },
  }, (err, resp, body) => {
    if (err) reject(err)
    resolve(resp)
  })
})

const responseHandlers = {
  'simple' : SimpleResponseHandler,
  'http'   : HTTPResponseHandler
}

const configResponseHandler = (responseHandler = 'simple') => {
  if ( typeof(responseHandler) === 'function') return responseHandler
  if ( typeof(responseHandler) === 'string') {
    if (!responseHandlers[responseHandler]) throw new Error(`Response handler configuration not available for '${net}'`)
    return responseHandlers[responseHandler]
  }
  throw new Error(`Not a valid responseHandler`)
}

const isShareRequest = (uri) => !!uri.match(/:me\?.*requestToken/g)
const isSimpleRequest = (uri) => !!uri.match(/:me\?/g)
const isTransactionRequest = (uri) => !!uri.match(/:0[xX][0-9a-fA-F]+\?/g)
const isAddAttestationRequest = (uri) => !!uri.match(/add\?/g)


// TODO consume both hex or buffer, add details about use, offer default hash func
const signer = (privKey) => (hash) =>  {
  const sig = secp256k1.sign(hash, new Buffer(ethutil.stripHexPrefix(privKey), 'hex'))
  return {r: sig.signature.slice(0, 32), s: sig.signature.slice(32, 64) , v: sig.recovery }
}

// Implements simple signer interface to used with our other eth-signers
class SimpleSigner {
  constructor(signer, address) {
    this.sign = signer
    this.address = address
  }

  getAddress(){
    return this.address
  }

  signRawTx(rawTx, callback) {
    var rawTx = ethutil.stripHexPrefix(rawTx);
    const txCopy = new Transaction(new Buffer(rawTx, 'hex'));
    const txHash = txCopy.hash(false)
    const signature = this.sign(txHash)
    txCopy.r = signature.r
    txCopy.s = signature.s
    txCopy.v = signature.v + 27
    callback(null, txCopy.serialize().toString('hex'));
  }
}

// Create a jwt signer using the base signer
const JWTSigner = (signer) => (jwt) => {
  const sign = signer
  const header = {typ: 'JWT', alg: 'ES256K'}
  const signingInput = [base64url.encode(JSON.stringify(header)), base64url.encode(JSON.stringify(jwt))].join('.')
  const hash = createHash(signingInput)
  const signature = sign(hash)
  // TODO add consistent use of signing libs, instead of a varying ones
  const derSignature = ECSignature({r: signature.r, s: signature.s, recoveryparam: signature.v}).toDER()
  const joseSig = derToJose(new Buffer(derSignature, 'ES256'))
  return [signingInput, joseSig].join('.')
}


class UPortMockClient {
  constructor(config = {}, initState = {}) {
    this.nonce = config.nonce || 0
    // Handle this differently once there is a test and full client
    this.responseHandler = configResponseHandler(config.responseHandler)
    // {key: value, ...}
    this.info  = initState.info || { }
    // this.credentials = {address: [{jwt: ..., json: ....}, ...], ...}
    this.credentials = initState.credentials || { }

     this.network = config.network ? configNetwork(config.network) : null  // have some default connect/setup testrpc

     if (this.network) {
       // Eventually consume an ipfs api client or at least some wrapper that allows a mock to be passed in
       this.ipfsUrl = config.ipfsConfig || 'https://ipfs.infura.io/ipfs/'
       // ^ TODO better ipfs config, pass in opts after or url above
       this.ipfs = new IPFS({ host: 'ipfs.infura.io', port: 5001, protocol: 'https' })

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

      this.provider = config.provider || new HttpProvider(this.network.rpcUrl);
      this.ethjs = this.provider ? new EthJS(this.provider) : null;

      // TODO how to config this
      this.registryAddress = this.network.registry
      this.identityManagerAddress = this.network.identityManager

  }
}

  genKeyPair() {
      const privateKey = SecureRandom.randomBuffer(32)
      const publicKey = ethutil.privateToPublic(privateKey)
      return {
        privateKey: `0x${privateKey.toString('hex')}`,
        publicKey: `0x04${publicKey.toString('hex')}`,
        address: `0x${ethutil.pubToAddress(publicKey).toString('hex')}`
      }
  }

  initKeys() {
    this.deviceKeys = this.genKeyPair()
    this.recoveryKeys = this.genKeyPair()
    this.initTokenSigner()
    this.initSimpleSigner()
  }

  initTokenSigner() {
    this.jwtSigner = JWTSigner(signer(this.deviceKeys.privateKey))
  }

  initSimpleSigner() {
    //  TODO consumes signer now, allow config of signer, or to be passed in opts
     this.simpleSigner = new SimpleSigner(signer(this.deviceKeys.privateKey), this.deviceKeys.address)
     this.transactionSigner = this.simpleSigner  //TODO Make less confusing, uses simpler signer until identity created then uses identity specific signer
  }

  initTransactionSigner(IdentityManagerAdress) {
     this.transactionSigner = new IMProxySigner(this.id, this.simpleSigner, IdentityManagerAdress)
  }

  initializeIdentity(){
    if (!this.network) return Promise.reject(new Error('No network configured'))
    const IdentityManagerAdress = this.identityManagerAddress
    const IdentityManager = Contract(IdentityManagerArtifact.abi).at(IdentityManagerAdress) // add config for this
    const Registry = Contract(RegistryArtifact.abi).at(this.network.registry)
    if (!this.deviceKeys) this.initKeys()
    const uri = IdentityManager.createIdentity(this.deviceKeys.address, this.recoveryKeys.address)

    return this.consume(uri)
            .then(this.ethjs.getTransactionReceipt.bind(this.ethjs))
            .then(receipt => {
              const log = receipt.logs[0]
              const createEventAbi = IdentityManager.abi.filter(obj => obj.type === 'event' && obj.name ==='IdentityCreated')[0]
              this.id = decodeEvent(createEventAbi, log.data, log.topics).identity
              this.initTransactionSigner(IdentityManagerAdress)

              const publicProfile = {
                  '@context': 'http://schema.org',
                  '@type': 'Person',
                  "publicKey": this.deviceKeys.publicKey
              }
              return new Promise((resolve, reject) => {
                this.ipfs.addJSON(publicProfile, (err, result) => {
                    if (err) reject(new Error(err))
                    resolve(result)
                })
              })
            }).then(hash => {
              const hexhash = new Buffer(base58.decode(hash)).toString('hex')
              // removes Qm from ipfs hash, which specifies length and hash
              const hashArg = `0x${hexhash.slice(4)}`
              const key = 'uPortProfileIPFS1220'
              return Registry.set(key, this.id, hexhash)
            })
            .then(this.consume.bind(this))
            .then(this.ethjs.getTransactionReceipt.bind(this.ethjs))
            .then(receipt => {
              // .. receipt
              return
            })
  }

  sign(payload) {
    const hash = SECP256K1Client.createHash(payload)
    return SECP256K1Client.signHash(hash, this.privateKey)
  }

  addProfileKey(key, value ) {
    this.info[key] = value
  }

  signRawTx(unsignedRawTx) {
    return new Promise((resolve, reject) => {
      this.transactionSigner.signRawTx(unsignedRawTx, (err, rawTx) => {
        if (err) reject(err)
        resolve(rawTx)
      })
    })
  }

  shareRequestHandler(uri) {
    const params = getUrlParams(uri)
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
    const response = this.jwtSigner(payload)

    if (this.network) {
      return this.verifyJWT(params.requestToken).then(() => this.responseHandler(response, token.callbackUrl))
    }
    // TODO how to return response
    // return this.responseHandler(response, token.callbackUrl)
  }

  simpleRequestHandler(uri) {
    // A simple request
    const params = getUrlParams(uri)
    const response = this.jwtSigner({iss: this.address, iat: new Date().getTime(), address: this.address})
    return this.responseHandler(response, params.callback_url)
  }

  transactionRequestHandler(uri) {
    const params = getUrlParams(uri)
    const to = uri.match(/0[xX][0-9a-fA-F]+/g)[0]
    const from = this.deviceKeys.address
    const data = params.bytecode || params.function ?  funcToData(params.function) : '0x' //TODO whats the proper null value?
    const nonce = this.nonce++
    const value = params.value || 0
    const gas = params.gas ? params.gas : 6000000
    // TODO good default or opts
    const gasPrice = 3000000
    const txObj = {to, value: new BN(value), data, gas, gasPrice, nonce, from}
    const tx = new Transaction(txObj)

    const unsignedRawTx = ethutil.bufferToHex(tx.serialize())
    tx.sign(new Buffer(this.deviceKeys.privateKey.slice(2), 'hex')) // TODO remove redundant, get hash from above

    if (this.ethjs) {
      return this.signRawTx(unsignedRawTx)
                 .then(rawTx => {
                   return this.ethjs.sendRawTransaction(rawTx)
                 }).then(txHash => {
                   return this.responseHandler(txHash, params.callback_url)
                 })
    } else {
      const txHash = util.bufferToHex(tx.hash(true))
      return this.responseHandler(txHash, params.callback_url)
    }
  }

  addAttestationRequestHandler(uri) {
    const params = getUrlParams(uri)
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
    // TODO standard response?
  }

  consume(uri) {
      if (isShareRequest(uri)) return this.shareRequestHandler(uri)
      if (isSimpleRequest(uri)) return this.simpleRequestHandler(uri)
      if (isTransactionRequest(uri)) return this.transactionRequestHandler(uri)
      if (isAddAttestationRequest(uri)) return this.addAttestationRequestHandler(uri)
      return Promise.reject(new Error('Invalid URI Passed'))
  }
}

module.exports = UPortMockClient
