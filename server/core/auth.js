const passport = require('passport')
const passportJWT = require('passport-jwt')
const _ = require('lodash')
const jwt = require('jsonwebtoken')
const moment = require('moment')
const Promise = require('bluebird')
const crypto = Promise.promisifyAll(require('crypto'))
const pem2jwk = require('pem-jwk').pem2jwk

const securityHelper = require('../helpers/security')

/* global WIKI */

module.exports = {
  strategies: {},
  guest: {
    cacheExpiration: moment.utc().subtract(1, 'd')
  },
  groups: {},
  validApiKeys: [],

  /**
   * Initialize the authentication module
   */
  init() {
    this.passport = passport

    passport.serializeUser((user, done) => {
      done(null, user.id)
    })

    passport.deserializeUser(async (id, done) => {
      try {
        const user = await WIKI.models.users.query().findById(id).withGraphFetched('groups').modifyGraph('groups', builder => {
          builder.select('groups.id', 'permissions')
        })
        if (user) {
          done(null, user)
        } else {
          done(new Error(WIKI.lang.t('auth:errors:usernotfound')), null)
        }
      } catch (err) {
        done(err, null)
      }
    })

    this.reloadGroups()
    this.reloadApiKeys()

    return this
  },

  /**
   * Load authentication strategies
   */
  async activateStrategies() {
    try {
      // Unload any active strategies
      WIKI.auth.strategies = {}
      const currentStrategies = _.keys(passport._strategies)
      _.pull(currentStrategies, 'session')
      _.forEach(currentStrategies, stg => { passport.unuse(stg) })

      // Load JWT
      passport.use('jwt', new passportJWT.Strategy({
        jwtFromRequest: securityHelper.extractJWT,
        secretOrKey: WIKI.config.certs.public,
        audience: WIKI.config.auth.audience,
        issuer: 'urn:wiki.js',
        algorithms: ['RS256']
      }, (jwtPayload, cb) => {
        cb(null, jwtPayload)
      }))

      // Load enabled strategies
      const enabledStrategies = await WIKI.models.authentication.getStrategies()
      for (let idx in enabledStrategies) {
        const stg = enabledStrategies[idx]
        if (!stg.isEnabled) { continue }
        try {
          const strategy = require(`../modules/authentication/${stg.key}/authentication.js`)

          stg.config.callbackURL = `${WIKI.config.host}/login/${stg.key}/callback`
          strategy.init(passport, stg.config)
          strategy.config = stg.config

          WIKI.auth.strategies[stg.key] = {
            ...strategy,
            ...stg
          }
          WIKI.logger.info(`Authentication Strategy ${stg.key}: [ OK ]`)
        } catch (err) {
          WIKI.logger.error(`Authentication Strategy ${stg.key}: [ FAILED ]`)
          WIKI.logger.error(err)
        }
      }
    } catch (err) {
      WIKI.logger.error(`Failed to initialize Authentication Strategies: [ ERROR ]`)
      WIKI.logger.error(err)
    }
  },

  /**
   * Authenticate current request
   *
   * @param {Express Request} req
   * @param {Express Response} res
   * @param {Express Next Callback} next
   */
  authenticate(req, res, next) {
    WIKI.auth.passport.authenticate('jwt', {session: false}, async (err, user, info) => {
      if (err) { return next() }

      // Expired but still valid within N days, just renew
      if (info instanceof Error && info.name === 'TokenExpiredError' && moment().subtract(14, 'days').isBefore(info.expiredAt)) {
        const jwtPayload = jwt.decode(securityHelper.extractJWT(req))
        try {
          const newToken = await WIKI.models.users.refreshToken(jwtPayload.id)
          user = newToken.user
          user.permissions = user.getGlobalPermissions()
          req.user = user

          // Try headers, otherwise cookies for response
          if (req.get('content-type') === 'application/json') {
            res.set('new-jwt', newToken.token)
          } else {
            res.cookie('jwt', newToken.token, { expires: moment().add(365, 'days').toDate() })
          }
        } catch (errc) {
          WIKI.logger.warn(errc)
          return next()
        }
      }

      // JWT is NOT valid, set as guest
      if (!user) {
        if (WIKI.auth.guest.cacheExpiration.isSameOrBefore(moment.utc())) {
          WIKI.auth.guest = await WIKI.models.users.getGuestUser()
          WIKI.auth.guest.cacheExpiration = moment.utc().add(1, 'm')
        }
        req.user = WIKI.auth.guest
        return next()
      }

      // Process API tokens
      if (_.has(user, 'api')) {
        if (!WIKI.config.api.isEnabled) {
          return next(new Error('API is disabled. You must enable it from the Administration Area first.'))
        } else if (_.includes(WIKI.auth.validApiKeys, user.api)) {
          req.user = {
            id: 1,
            email: 'api@localhost',
            name: 'API',
            pictureUrl: null,
            timezone: 'America/New_York',
            localeCode: 'en',
            permissions: _.get(WIKI.auth.groups, `${user.grp}.permissions`, []),
            groups: [user.grp],
            getGlobalPermissions () {
              return req.user.permissions
            },
            getGroups () {
              return req.user.groups
            }
          }
          return next()
        } else {
          return next(new Error('API Key is invalid or was revoked.'))
        }
      }

      // JWT is valid
      req.logIn(user, { session: false }, (errc) => {
        if (errc) { return next(errc) }
        next()
      })
    })(req, res, next)
  },

  /**
   * Check if user has access to resource
   *
   * @param {User} user
   * @param {Array<String>} permissions
   * @param {String|Boolean} path
   */
  checkAccess(user, permissions = [], page = false) {
    const userPermissions = user.permissions ? user.permissions : user.getGlobalPermissions()

    // System Admin
    if (_.includes(userPermissions, 'manage:system')) {
      return true
    }

    // Check Global Permissions
    if (_.intersection(userPermissions, permissions).length < 1) {
      return false
    }

    // Check Page Rules
    if (page && user.groups) {
      let checkState = {
        deny: false,
        match: false,
        specificity: ''
      }
      user.groups.forEach(grp => {
        const grpId = _.isObject(grp) ? _.get(grp, 'id', 0) : grp
        _.get(WIKI.auth.groups, `${grpId}.pageRules`, []).forEach(rule => {
          if (_.intersection(rule.roles, permissions).length > 0) {
            switch (rule.match) {
              case 'START':
                if (_.startsWith(`/${page.path}`, `/${rule.path}`)) {
                  checkState = this._applyPageRuleSpecificity({ rule, checkState, higherPriority: ['END', 'REGEX', 'EXACT', 'TAG'] })
                }
                break
              case 'END':
                if (_.endsWith(page.path, rule.path)) {
                  checkState = this._applyPageRuleSpecificity({ rule, checkState, higherPriority: ['REGEX', 'EXACT', 'TAG'] })
                }
                break
              case 'REGEX':
                const reg = new RegExp(rule.path)
                if (reg.test(page.path)) {
                  checkState = this._applyPageRuleSpecificity({ rule, checkState, higherPriority: ['EXACT', 'TAG'] })
                }
                break
              case 'TAG':
                _.get(page, 'tags', []).forEach(tag => {
                  if (tag.tag === rule.path) {
                    checkState = this._applyPageRuleSpecificity({
                      rule,
                      checkState,
                      higherPriority: ['EXACT']
                    })
                  }
                })
                break
              case 'EXACT':
                if (`/${page.path}` === `/${rule.path}`) {
                  checkState = this._applyPageRuleSpecificity({ rule, checkState, higherPriority: [] })
                }
                break
            }
          }
        })
      })

      return (checkState.match && !checkState.deny)
    }

    return false
  },

  /**
   * Check and apply Page Rule specificity
   *
   * @access private
   */
  _applyPageRuleSpecificity ({ rule, checkState, higherPriority = [] }) {
    if (rule.path.length === checkState.specificity.length) {
      // Do not override higher priority rules
      if (_.includes(higherPriority, checkState.match)) {
        return checkState
      }
      // Do not override a previous DENY rule with same match
      if (rule.match === checkState.match && checkState.deny && !rule.deny) {
        return checkState
      }
    } else if (rule.path.length < checkState.specificity.length) {
      // Do not override higher specificity rules
      return checkState
    }

    return {
      deny: rule.deny,
      match: rule.match,
      specificity: rule.path
    }
  },

  /**
   * Reload Groups from DB
   */
  async reloadGroups () {
    const groupsArray = await WIKI.models.groups.query()
    this.groups = _.keyBy(groupsArray, 'id')
    WIKI.auth.guest.cacheExpiration = moment.utc().subtract(1, 'd')
  },

  /**
   * Reload valid API Keys from DB
   */
  async reloadApiKeys () {
    const keys = await WIKI.models.apiKeys.query().select('id').where('isRevoked', false).andWhere('expiration', '>', moment.utc().toISOString())
    this.validApiKeys = _.map(keys, 'id')
  },

  /**
   * Generate New Authentication Public / Private Key Certificates
   */
  async regenerateCertificates () {
    WIKI.logger.info('Regenerating certificates...')

    _.set(WIKI.config, 'sessionSecret', (await crypto.randomBytesAsync(32)).toString('hex'))
    const certs = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'pkcs1',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs1',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: WIKI.config.sessionSecret
      }
    })

    _.set(WIKI.config, 'certs', {
      jwk: pem2jwk(certs.publicKey),
      public: certs.publicKey,
      private: certs.privateKey
    })

    await WIKI.configSvc.saveToDb([
      'certs',
      'sessionSecret'
    ])

    await WIKI.auth.activateStrategies()
    WIKI.events.outbound.emit('reloadAuthStrategies')

    WIKI.logger.info('Regenerated certificates: [ COMPLETED ]')
  },

  /**
   * Reset Guest User
   */
  async resetGuestUser() {
    WIKI.logger.info('Resetting guest account...')
    const guestGroup = await WIKI.models.groups.query().where('id', 2).first()

    await WIKI.models.users.query().delete().where({
      providerKey: 'local',
      email: 'guest@example.com'
    }).orWhere('id', 2)

    const guestUser = await WIKI.models.users.query().insert({
      id: 2,
      provider: 'local',
      email: 'guest@example.com',
      name: 'Guest',
      password: '',
      locale: 'en',
      defaultEditor: 'markdown',
      tfaIsActive: false,
      isSystem: true,
      isActive: true,
      isVerified: true
    })
    await guestUser.$relatedQuery('groups').relate(guestGroup.id)

    WIKI.logger.info('Guest user has been reset: [ COMPLETED ]')
  },

  /**
   * Subscribe to HA propagation events
   */
  subscribeToEvents() {
    WIKI.events.inbound.on('reloadGroups', () => {
      WIKI.auth.reloadGroups()
    })
    WIKI.events.inbound.on('reloadApiKeys', () => {
      WIKI.auth.reloadApiKeys()
    })
    WIKI.events.inbound.on('reloadAuthStrategies', () => {
      WIKI.auth.activateStrategies()
    })
  }
}
