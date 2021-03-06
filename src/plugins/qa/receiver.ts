import {
  Context,
  User,
  Session,
  NextFunction,
  Argv,
  segment,
  noop,
  escapeRegExp,
  Random,
  makeArray,
  Awaitable,
} from 'koishi'
import { Dialogue, DialogueTest } from './utils'
import { simplify } from 'simplify-chinese'

declare module 'koishi' {
  interface App {
    _dialogueStates: Record<number, SessionState>
  }

  interface EventMap {
    'dialogue/state'(state: SessionState): void
    'dialogue/receive'(state: SessionState): void | boolean
    'dialogue/prepare'(state: SessionState): void
    'dialogue/before-attach-user'(
      state: SessionState,
      userFields: Set<User.Field>
    ): void
    'dialogue/attach-user'(state: SessionState): void | boolean
    'dialogue/before-send'(state: SessionState): Awaitable<void | boolean>
    'dialogue/send'(state: SessionState): void
  }

  interface Context {
    getSessionState(this: Context, session: Session): SessionState
  }

  interface Session {
    _redirected?: number
  }
}

interface Question {
  /** 被 unescape 处理后原本的句子 */
  original: string
  /** 去除句首句尾标点符号，句中空格和句首称呼的句子 */
  parsed: string
  /** 是否含有称呼 */
  appellative: boolean
  /** 是否仅含有称呼 */
  activated: boolean
}

declare module './utils' {
  namespace Dialogue {
    interface Config {
      nickname?: string | string[]
      appellationTimeout?: number
      maxRedirections?: number
      _stripQuestion?(source: string): Question
    }
  }
}

export interface SessionState {
  userId?: string
  channelId?: string
  answer?: string
  session?: Session<User.Field>
  test?: DialogueTest
  dialogue?: Dialogue
  dialogues?: Dialogue[]
  next?: NextFunction
  isSearch?: boolean
}

export function escapeAnswer(message: string): string {
  return message.replace(/\$/g, '@@__PLACEHOLDER__@@')
}

export function unescapeAnswer(message: string): string {
  return message.replace(/@@__PLACEHOLDER__@@/g, '$')
}

Context.prototype.getSessionState = function (session) {
  const { channelId, userId, app } = session
  if (!app._dialogueStates[channelId]) {
    this.emit(
      'dialogue/state',
      (app._dialogueStates[channelId] = { channelId } as SessionState)
    )
  }
  const state = Object.create(app._dialogueStates[channelId])
  state.session = session
  state.userId = userId
  return state
}

export class MessageBuffer {
  private buffer = ''
  private original = false

  public hasData = false
  public send: Session['send']
  public sendQueued: Session['sendQueued']

  constructor(private session: Session) {
    this.send = session.send.bind(session)
    this.sendQueued = session.sendQueued.bind(session)

    session.send = async (message: string) => {
      if (!message) return
      this.hasData = true
      if (this.original) {
        return this.send(message)
      }
      this.buffer += message
    }

    session.sendQueued = async (message, delay) => {
      if (!message) return
      this.hasData = true
      if (this.original) {
        return this.sendQueued(message, delay)
      }
      return this._flush(this.buffer + message, delay)
    }
  }

  write(message: string): void {
    if (!message) return
    this.hasData = true
    this.buffer += message
  }

  private async _flush(message: string, delay?: number) {
    this.original = true
    message = message.trim()
    await this.sendQueued(message, delay)
    this.buffer = ''
    this.original = false
  }

  flush(): Promise<void> {
    return this._flush(this.buffer)
  }

  async execute(argv: Argv): Promise<void> {
    this.original = false
    const send = this.session.send
    const sendQueued = this.session.sendQueued
    await this.session.execute(argv)
    this.session.sendQueued = sendQueued
    this.session.send = send
    this.original = true
  }

  async end(message = ''): Promise<void> {
    this.write(message)
    await this.flush()
    this.original = true
    delete this.session.send
    delete this.session.sendQueued
  }
}

const tokenizer = new Argv.Tokenizer()

tokenizer.interpolate('$n', '', (rest) => {
  return { rest, tokens: [], source: '' }
})

const halfWidth = ',,.~?!()[]'
const fullWidth = '，、。～？！（）【】'
const fullWidthRegExp = new RegExp(`[${fullWidth}]`)

export async function triggerDialogue(
  ctx: Context,
  session: Session,
  next: NextFunction = noop
): Promise<void> {
  const state = ctx.getSessionState(session)
  state.next = next
  state.test = {}

  if (ctx.bail('dialogue/receive', state)) return next()
  const logger = ctx.logger('dialogue')
  logger.debug('[receive]', session.messageId, session.content)

  // fetch matched dialogues
  const dialogues = (state.dialogues = await Dialogue.get(ctx, state.test))

  // pick dialogue
  let dialogue: Dialogue
  const target = Random.real(1)
  let pointer = 0
  for (const _dialogue of dialogues) {
    pointer += 1
    if (target < pointer) {
      dialogue = _dialogue
      break
    }
  }
  if (!dialogue) return next()
  logger.debug('[attach]', session.messageId)

  // parse answer
  state.dialogue = dialogue
  state.dialogues = [dialogue]
  state.answer = dialogue.answer
    .replace(/\$\$/g, '@@__PLACEHOLDER__@@')
    .replace(/\$A/g, segment('at', { type: 'all' }))
    .replace(/\$a/g, segment('at', { id: session.userId }))
    .replace(/\$m/g, segment('at', { id: session.selfId }))
    .replace(/\$s/g, () => escapeAnswer(session.username))
    .replace(/\$0/g, escapeAnswer(session.content))

  if (dialogue.flag & Dialogue.Flag.regexp) {
    const capture =
      dialogue._capture ||
      new RegExp(dialogue.original, 'i').exec(state.test.original)
    // emojis will be transformed into "?" in mysql
    // which will lead to incorrect matches
    // TODO enhance emojis in regexp tests
    if (!capture) return
    capture.map((segment, index) => {
      if (index && index <= 9) {
        state.answer = state.answer.replace(
          new RegExp(`\\$${index}`, 'g'),
          escapeAnswer(segment || '')
        )
      }
    })
  }

  if (await ctx.app.serial(session, 'dialogue/before-send', state)) return
  logger.debug('[send]', session.messageId, '->', dialogue.answer)

  // send answers
  const buffer = new MessageBuffer(session)
  session._redirected = (session._redirected || 0) + 1

  // parse answer
  let index: number
  const { content, inters } = tokenizer.parseToken(unescapeAnswer(state.answer))
  while (inters.length) {
    const argv = inters.shift()
    buffer.write(content.slice(index, argv.pos))
    if (argv.initiator === '$n') {
      await buffer.flush()
    } else {
      await buffer.execute(argv)
    }
    index = argv.pos
  }
  await buffer.end(content.slice(index))
  await ctx.app.parallel(session, 'dialogue/send', state)
}

export default function apply(ctx: Context, config: Dialogue.Config): void {
  const { nickname = ctx.app.options.nickname, maxRedirections = 3 } = config
  const nicknames = makeArray(nickname).map(escapeRegExp)
  const nicknameRE = new RegExp(`^((${nicknames.join('|')})[,，]?\\s*)+`)
  const ctx2 = ctx.guild()

  ctx.app._dialogueStates = {}

  config._stripQuestion = (source) => {
    const original = segment.unescape(source)
    source = segment.transform(source, {
      text: ({ content }, index, chain) => {
        let message = simplify(segment.unescape('' + content))
          .toLowerCase()
          .replace(/\s+/g, '')
          .replace(fullWidthRegExp, ($0) => halfWidth[fullWidth.indexOf($0)])
        if (index === 0) message = message.replace(/^[()[\]]*/, '')
        if (index === chain.length - 1)
          message = message.replace(/[.,?!()[\]~]*$/, '')
        return message
      },
    })
    const capture = nicknameRE.exec(source)
    const unprefixed = capture ? source.slice(capture[0].length) : source
    return {
      original,
      parsed: unprefixed || source,
      appellative: unprefixed && unprefixed !== source,
      activated: !unprefixed && unprefixed !== source,
    }
  }

  ctx.on('dialogue/receive', ({ session }) => {
    // generally flag and authority has already attached to users
    if (session.user?.authority < config.authority.receive) return true
  })

  ctx.on('dialogue/receive', ({ session, test }) => {
    if (session.content.includes('[CQ:image,')) return true
    const { original, parsed, appellative, activated } = config._stripQuestion(
      session.content
    )
    test.question = parsed
    test.original = original
    test.activated = activated
    test.appellative = appellative
  })

  // 预判要获取的用户字段
  ctx.before('dialogue/attach-user', ({ dialogues, session }, userFields) => {
    for (const data of dialogues) {
      const { inters } = tokenizer.parseToken(data.answer)
      for (const argv of inters) {
        session.collect('user', argv, userFields)
      }
    }
  })

  ctx2
    .command('dialogue <message:text>', '触发教学对话')
    .action(async ({ session, next }, message = '') => {
      if (session._redirected > maxRedirections) return next()
      session.content = message
      return triggerDialogue(ctx, session, next)
    })
}
