import type { Personality } from '../domain/types.ts'

export interface VoiceViolation {
  rule: string
  detail: string
}

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u

/**
 * The "never" list from the voice spec. Most of it is literally string
 * matching, which is why enforcement belongs here rather than in a prompt.
 */
const BANS: Array<{ rule: string; test: RegExp; detail: string }> = [
  { rule: 'no-exclamation', test: /!/, detail: 'exclamation mark' },
  { rule: 'no-emoji', test: EMOJI, detail: 'emoji' },
  { rule: 'no-lets', test: /\blet'?s\b/i, detail: '"let\'s"' },
  { rule: 'no-ai-reference', test: /\b(?:as an ai|language model|i am an ai|as your ai)\b/i, detail: 'reference to being an AI' },
  { rule: 'no-hype', test: /\b(?:amazing|awesome|incredible|stunning|must-see|bucket[- ]list|hidden gem)\b/i, detail: 'hype adjective' },
  { rule: 'no-second-guessing-choices', test: /\b(?:great choice|excellent pick|you'?ll love)\b/i, detail: 'enthusiasm about the traveller\'s choices' },
]

/** Sentence count, used for the length ceiling. Abbreviations are close enough. */
export function sentenceCount(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0).length
}

const MAX_SENTENCES: Record<Personality, number> = {
  absent: 1,
  quiet: 2,
  warm: 3,
  full: 3,
}

export function checkVoice(text: string, personality: Personality): VoiceViolation[] {
  const violations: VoiceViolation[] = []
  for (const ban of BANS) {
    if (ban.test.test(text)) violations.push({ rule: ban.rule, detail: ban.detail })
  }
  const limit = MAX_SENTENCES[personality]
  const count = sentenceCount(text)
  if (count > limit) {
    violations.push({
      rule: 'length',
      detail: `${count} sentences exceeds the ${limit}-sentence ceiling for ${personality} voice`,
    })
  }
  if (personality === 'absent' && /\b(?:I|me|my)\b/.test(text)) {
    violations.push({ rule: 'no-persona-in-safety', detail: 'first person in a safety card' })
  }
  return violations
}

/**
 * Violations are fatal where a wrong or chatty card does real damage, and
 * advisory where the worst case is a slightly worse read.
 */
export function violationsAreFatal(personality: Personality): boolean {
  return personality === 'absent' || personality === 'quiet'
}
