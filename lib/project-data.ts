// 项目（Project）：把相关对谈归到一起，并挂上参考资料与专属指令/人设
export type Project = {
  id: string
  name: string
  instructions: string
  date: string
}

// 项目参考资料：上传文件抽取出的纯文本（PDF 走服务端解析，文本直接读）
export type ProjectFile = {
  id: string
  name: string
  content: string
}

// 聊天时喂给模型的项目背景：专属指令 + 资料正文
export type ProjectContext = {
  instructions: string
  files: { name: string; content: string }[]
}
