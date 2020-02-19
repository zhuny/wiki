#!/usr/bin/env node

// ===========================================
// Wiki.js DEV UTILITY
// Licensed under AGPLv3
// ===========================================

const Promise = require('bluebird')
const _ = require('lodash')
const chalk = require('chalk')

const init = {
  dev() {
    const webpack = require('webpack')
    const chokidar = require('chokidar')

    console.info(chalk.yellow.bold('--- ====================== ---'))
    console.info(chalk.yellow.bold('--- Wiki.js DEVELOPER MODE ---'))
    console.info(chalk.yellow.bold('--- ====================== ---'))

    global.DEV = true
    global.WP_CONFIG = require('./webpack/webpack.dev.js')
    global.WP = webpack(global.WP_CONFIG)
    global.WP_DEV = {
      devMiddleware: require('webpack-dev-middleware')(global.WP, {
        publicPath: global.WP_CONFIG.output.publicPath
      }),
      hotMiddleware: require('webpack-hot-middleware')(global.WP)
    }
    global.WP_DEV.devMiddleware.waitUntilValid(() => {
      console.info(chalk.yellow.bold('>>> Starting Wiki.js in DEVELOPER mode...'))
      require('../server')

      process.stdin.setEncoding('utf8')
      process.stdin.on('data', data => {
        if (_.trim(data) === 'rs') {
          console.warn(chalk.yellow.bold('--- >>>>>>>>>>>>>>>>>>>>>>>> ---'))
          console.warn(chalk.yellow.bold('--- Manual restart requested ---'))
          console.warn(chalk.yellow.bold('--- <<<<<<<<<<<<<<<<<<<<<<<< ---'))
          this.reload()
        }
      })

      const devWatcher = chokidar.watch([
        './server',
        '!./server/views/master.pug'
      ], {
        cwd: process.cwd(),
        ignoreInitial: true,
        atomic: 400
      })
      devWatcher.on('ready', () => {
        devWatcher.on('all', _.debounce(() => {
          console.warn(chalk.yellow.bold('--- >>>>>>>>>>>>>>>>>>>>>>>>>>>> ---'))
          console.warn(chalk.yellow.bold('--- Changes detected: Restarting ---'))
          console.warn(chalk.yellow.bold('--- <<<<<<<<<<<<<<<<<<<<<<<<<<<< ---'))
          this.reload()
        }, 500))
      })
    })
  },
  async reload() {
    console.warn(chalk.yellow('--- Stopping scheduled jobs...'))
    if (global.WIKI.scheduler) {
      global.WIKI.scheduler.stop()
    }
    console.warn(chalk.yellow('--- Closing DB connections...'))
    await global.WIKI.models.knex.destroy()
    console.warn(chalk.yellow('--- Closing Server connections...'))
    if (global.WIKI.servers) {
      await global.WIKI.servers.stopServers()
    }
    console.warn(chalk.yellow('--- Purging node modules cache...'))

    global.WIKI = {}
    Object.keys(require.cache).forEach(id => {
      if (/[/\\]server[/\\]/.test(id)) {
        delete require.cache[id]
      }
    })
    Object.keys(module.constructor._pathCache).forEach(cacheKey => {
      if (/[/\\]server[/\\]/.test(cacheKey)) {
        delete module.constructor._pathCache[cacheKey]
      }
    })

    console.warn(chalk.yellow('--- Unregistering process listeners...'))

    process.removeAllListeners('unhandledRejection')
    process.removeAllListeners('uncaughtException')

    require('../server')
  }
}

init.dev()
