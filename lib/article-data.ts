export type DailyArticle = {
  id: string
  briefDate: string
  position: number
  category: string
  title: string
  dek: string
  body: string
  readMinutes: number
  coverVariant: number
  coverImageUrl?: string | null
  createdAt: string
}

export type DailyBriefResponse = {
  date: string
  articles: DailyArticle[]
}

export function localDateParts(date = new Date(), timeZone = "America/Chicago") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ""
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour")),
  }
}

export function articleWordCount(body: string) {
  return body.trim().split(/\s+/).filter(Boolean).length
}

