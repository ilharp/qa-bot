import './env'

import { App } from 'koishi'

import * as pluginOnebot from '@koishijs/plugin-onebot'
import * as pluginCommon from '@koishijs/plugin-common'
import * as pluginMysql from '@koishijs/plugin-mysql'

const app = new App()

// Configure onebot
app.plugin(pluginOnebot, {
  protocol: 'ws',
  selfId: process.env.ONEBOT_SELF_ID,
  endpoint: process.env.ONEBOT_WS_ENDPOINT,
})

// Configure Mysql
app.plugin(pluginMysql, {
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: process.env.KOISHI_MYSQL_PASS,
  database: 'qabot',
})

// Configure plugin-common
app.plugin(pluginCommon)

app.start()
