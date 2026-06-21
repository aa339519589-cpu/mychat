export type ModelId = "claude" | "gpt"

export type Model = {
  id: ModelId
  name: string
  subtitle: string
}

export const MODELS: Model[] = [
  { id: "claude", name: "笔友", subtitle: "沉静 · 善思辨" },
  { id: "gpt", name: "笔友", subtitle: "敏捷 · 多才情" },
]

export type Message = {
  id: string
  role: "user" | "assistant"
  content: string
  time: string
  thinking?: {
    isThinking: boolean
    duration?: number // 秒数
  }
}

export type Conversation = {
  id: string
  title: string
  excerpt: string
  date: string
  messages: Message[]
}

export const CONVERSATIONS: Conversation[] = [
  {
    id: "c1",
    title: "论独处的艺术",
    excerpt: "我们谈到了如何在喧嚣里，为自己留一方安静的庭院……",
    date: "今日",
    messages: [
      {
        id: "m1",
        role: "user",
        content:
          "最近总觉得心绪浮躁，难以独处。你怎么看待一个人独处这件事？",
        time: "上午 9:14",
      },
      {
        id: "m2",
        role: "assistant",
        content:
          "独处并非孤独，而是一种与自己重新熟络的方式。喧嚣会让人误以为热闹即充实，可真正的丰盈，往往诞生于无人打扰的片刻。\n\n不妨这样想：独处是给灵魂留出的留白，正如一幅好的书法，墨色之外的空白同样是作品的一部分。你不必急着填满它，只需安然坐在其中，听一听自己内心真正的声音。",
        time: "上午 9:14",
        thinking: { isThinking: true, duration: 3 },
      },
      {
        id: "m3",
        role: "user",
        content: "可独处久了，又怕与世界脱节。这个分寸该如何把握？",
        time: "上午 9:16",
      },
      {
        id: "m4",
        role: "assistant",
        content:
          "分寸感来自节律，而非比例。如同呼吸——吸气是向内的独处，呼气是向外的联结，二者皆不可偏废，却也无需精确计量。\n\n你会在某个清晨醒来，自然想要见一位旧友；也会在某个黄昏，只愿与一盏茶、一本书相对。顺应这种潮汐，便是最好的把握。",
        time: "上午 9:17",
      },
    ],
  },
  {
    id: "c2",
    title: "雨夜读诗札记",
    excerpt: "关于李商隐的『留得枯荷听雨声』，我们聊了很久……",
    date: "昨日",
    messages: [
      {
        id: "m1",
        role: "user",
        content: "今夜有雨，忽然想起『留得枯荷听雨声』，请你为我讲讲这句诗。",
        time: "晚上 10:02",
      },
      {
        id: "m2",
        role: "assistant",
        content:
          "这一句出自李商隐《宿骆氏亭寄怀崔雍崔衮》。枯荷本是衰败之物，诗人却舍不得清理，只为在雨夜里听那雨打残荷的声响。\n\n这里头藏着一种极深的况味：美不只在繁盛，也在凋零之后的余韵。枯荷与雨声相和，是寂寥，也是慰藉。人到某个年岁，便会懂得欣赏这种残缺之美了。",
        time: "晚上 10:03",
      },
    ],
  },
  {
    id: "c3",
    title: "写给三年后的自己",
    excerpt: "一封缓慢酝酿的信，记下此刻的犹疑与期许……",
    date: "三天前",
    messages: [
      {
        id: "m1",
        role: "user",
        content: "我想给三年后的自己写一封信，却不知从何落笔。",
        time: "下午 3:40",
      },
      {
        id: "m2",
        role: "assistant",
        content:
          "不妨从此刻的一个细节写起——窗外的光、手边的温度、心里悬而未决的某件事。信不必宏大，真切便好。\n\n你可以告诉三年后的自己：我曾在这样一个平凡的午后，认真地想念过你。",
        time: "下午 3:41",
      },
    ],
  },
  {
    id: "c4",
    title: "关于时间的隐喻",
    excerpt: "时间是河流，还是一座层层叠叠的庭院？",
    date: "上周",
    messages: [
      {
        id: "m1",
        role: "user",
        content: "人们总把时间比作河流，你会用什么来比喻它？",
        time: "上午 11:20",
      },
      {
        id: "m2",
        role: "assistant",
        content:
          "我更愿把时间想象成一座旧宅。每一间房都是一段往昔，门虚掩着，偶尔一阵风，便有旧日的气息飘来。\n\n我们以为自己走在长廊上一路向前，其实从未真正离开任何一间房。",
        time: "上午 11:21",
      },
    ],
  },
]
