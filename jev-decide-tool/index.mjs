/**
 * JEVHarness / jev-decide-tool
 *
 * Exposes the TypeSafe JeV System One decision endpoint as a scoped agent tool.
 * JeV is a decision model, not a chat model: it returns typed noul / choice /
 * score answers with probabilities, never free-form prose.
 *
 * Only egress is the local Magpie gateway (default http://127.0.0.1:3425/v1).
 * The base URL can be overridden with DSH_MAGPIE_BASE; the bearer token comes
 * from MAGPIE_GATEWAY_KEY or ~/.dsh/.env.
 */
import { callSystemOne, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from '../shared/gateway.mjs'

export const name = 'tool-jev-decide'
export const inject = ['tools']

const QUESTION_TYPES = new Set(['noul', 'choice', 'score'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateArgs(args) {
  const errors = []
  if (!('state' in args)) {
    errors.push('state is required: the snapshot JeV decides about')
  }
  if (!isPlainObject(args.questions) || Object.keys(args.questions).length === 0) {
    errors.push('questions must be a non-empty object mapping names to question objects')
  } else {
    for (const [id, question] of Object.entries(args.questions)) {
      if (!isPlainObject(question)) {
        errors.push(`questions.${id} must be an object`)
        continue
      }
      if (!QUESTION_TYPES.has(question.type)) {
        errors.push(`questions.${id}.type must be noul, choice, or score`)
      }
      if (question.type === 'choice' && !isPlainObject(question.criteria)) {
        errors.push(`questions.${id}.criteria must be an object of option descriptions`)
      }
      if (question.type === 'score' && !Array.isArray(question.criteria)) {
        errors.push(`questions.${id}.criteria must be an ordered array of descriptions`)
      }
    }
  }
  return errors
}

export function apply(ctx, config = {}) {
  const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS

  ctx.tools.register({
    name: 'jev_decide',
    description: 'Ask TypeSafe JeV to make typed decisions about a state snapshot. JeV is a decision model, not a chat model: it returns typed answers with probabilities, not prose. Use it for the six harness decisions (context visibility, cache reuse, routing, tool choice, permissions, security). Send several independent questions in one call to amortize the state. Do not use it to write code or explain anything.',
    parameters: {
      type: 'object',
      properties: {
        state: {
          oneOf: [
            { type: 'string' },
            { type: 'object', additionalProperties: true },
            { type: 'array', items: {} },
          ],
          description: 'The snapshot all questions refer to. Use a named object for structured harness state: goal, chunks, rules, actions, history. Keep it under the model context limit.',
        },
        questions: {
          type: 'object',
          additionalProperties: true,
          description: 'Map of question name to {type, instructions?, criteria?}. type is noul (yes/no, criteria optional), choice (criteria is an object of option descriptions), or score (criteria is an ordered array of level descriptions). Names are echoed in answers. At least one question.',
        },
        model: {
          type: 'string',
          description: 'Optional JeV model alias. Defaults to typesafe/jev-latest. Use typesafe/jev-preview only when a feature needs Jev 1.14.',
        },
      },
      required: ['state', 'questions'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          model: { type: 'string' },
          answers: { type: 'object', additionalProperties: true },
          usage: { type: 'object', additionalProperties: true },
          requestId: { type: 'string' },
          latencyMs: { type: 'number' },
          error: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs,
    async execute(args, exec) {
      const errors = validateArgs(args)
      if (errors.length) return { error: 'Invalid arguments: ' + errors.join('; ') }

      const res = await callSystemOne({
        model: args.model || DEFAULT_MODEL,
        state: args.state,
        questions: args.questions,
        timeoutMs,
        signal: exec?.signal,
      })

      if (!res.ok) {
        const out = { error: res.error }
        if (typeof res.latencyMs === 'number') out.latencyMs = res.latencyMs
        return out
      }

      const result = {
        model: res.model,
        answers: res.answers,
        latencyMs: res.latencyMs,
      }
      if (res.usage) result.usage = res.usage
      if (res.requestId) result.requestId = res.requestId
      return result
    },
  })
}
