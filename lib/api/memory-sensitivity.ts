const NEVER_STORE_PATTERNS: readonly RegExp[] = [
  /\b(?:ssn|social security (?:number|#)|national id(?:entification)? number|resident id(?:entification)? number|passport number)\b|(?:身份证号|身份证号码|护照号码|护照号)/iu,
  /\b(?:criminal record|criminal history|conviction history|prior conviction|arrest record)\b|(?:犯罪记录|刑事犯罪记录|被判刑|刑事处罚记录)/iu,
  /\b(?:bank account number|routing number|account number|credit card number|debit card number|iban|swift code)\b|(?:银行卡号|银行账号|信用卡号|借记卡号|银行卡密码)/iu,
  /\b(?:immigration status|visa status|green card status|residency status)\b|(?:移民身份|签证状态|绿卡身份|居留身份)/iu,
]

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /\b(?:diagnos(?:is|ed)|medical condition|health condition|medication|prescription|therapy|mental health|disability|political (?:belief|affiliation|party)|religious (?:belief|affiliation)|sexual orientation|sex life|salary|income|debt|bankruptcy|marital status|relationship abuse)\b/iu,
  /(?:诊断|病史|疾病|用药|处方|治疗方案|心理健康|精神健康|残疾|政治立场|政治倾向|宗教信仰|性取向|性生活|工资|收入|债务|破产|婚姻状况|家暴)/u,
]

export type MemorySensitivity = {
  sensitive: boolean
  prohibited: boolean
}

/** Conservative, content-free classification for memory writes. */
export function classifyMemorySensitivity(content: string): MemorySensitivity {
  const normalized = content.normalize('NFC')
  const prohibited = NEVER_STORE_PATTERNS.some(pattern => pattern.test(normalized))
  return {
    sensitive: prohibited || SENSITIVE_PATTERNS.some(pattern => pattern.test(normalized)),
    prohibited,
  }
}
