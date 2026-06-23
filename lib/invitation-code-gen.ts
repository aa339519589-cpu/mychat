const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const CODE_LENGTH = 24

export function generateInvitationCode(): string {
  let code = ''
  const charsArray = new Uint8Array(CODE_LENGTH)
  crypto.getRandomValues(charsArray)
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CHARSET[charsArray[i] % CHARSET.length]
  }
  return code
}
