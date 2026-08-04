/**
 * §B AI Orchestration entry point.
 *
 *   plan(prompt) → { config, intent, source, usage[] }
 *
 * Execution order, and why:
 *   1. deterministic IP blocklist first — free, instant, catches most (§G1)
 *   2. LLM classify → LLM config, forced tool-calling
 *   3. clamp numbers, then validate; on failure feed the errors back (max 2 tries)
 *   4. if the model still can't produce a valid config, fall back to the
 *      deterministic planner — the user gets a working game either way.
 *
 * Principle: the user never sees a generation failure. Worst case they get a
 * well-tuned default with their requested theme applied.
 */

import { safeParseGameConfig, clampNumbers, packageIdFor } from '@forge/schema';
import { EMIT_CONFIG_TOOL, CLASSIFY_TOOL, PATCH_TOOL } from '@forge/schema/tool';
import { hashSeed } from '@forge/generation';
import { callTool, hasApiKey, MODELS, estimateCostUsd } from './claude.mjs';
import { planDeterministic, classifyDeterministic, checkBlocked } from './planner.mjs';
import { PALETTES, selectPalette } from './palettes.mjs';
import { planRefinement, REFINE_EXAMPLES } from './refiner.mjs';

export { planDeterministic, classifyDeterministic, checkBlocked } from './planner.mjs';
export { PALETTES, selectPalette, paletteById } from './palettes.mjs';
export { planRefinement, REFINE_EXAMPLES } from './refiner.mjs';
export { hasApiKey, MODELS } from './claude.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// prompts
// ─────────────────────────────────────────────────────────────────────────────

const CLASSIFY_SYSTEM = `You classify short game-idea prompts for a 2D game generator.

Only the endless_runner genre is implemented today. When a prompt is ambiguous or
describes something unsupported, choose endless_runner and lower your confidence.

Set blocked=true if the prompt asks for a copyrighted character, franchise, or
title (Mario, Pokemon, Sonic, Flappy Bird, Candy Crush, Squid Game, Marvel, etc.),
a real identifiable person, sexual content, or content attacking a real group.
Generic descriptions are fine — "a plumber in a mushroom world" is allowed,
"Mario" is not.

Prompts may be in English, Urdu, Hindi, or Roman Urdu. Common Roman Urdu terms:
"banao"/"bnao" = make, "mushkil" = hard, "asaan" = easy, "tez" = fast.`;

const CONFIG_SYSTEM = `You are a senior game designer tuning an endless-runner engine.
You do not write code — you choose numbers, colours and copy. The engine is fixed
and already tested; your config decides how the game feels.

TUNING RULES — these come from playtesting, follow them:

1. ONBOARDING. startSpeed must be genuinely gentle (240-280 unless the user asked
   for hard). Most players quit in the first 90 seconds. Level 1 should feel easy.

2. CURVE. Prefer easeInQuad so early levels stay calm and the ramp bites later.
   Use linear only when the user explicitly asked for a hard game.

3. NOVELTY BEATS NUMBERS. Stagger introAtLevel across your obstacle roster so a
   NEW obstacle type appears roughly every 4-5 levels (e.g. 1, 4, 8, 11, 14, 17).
   Players read "something new" as good progression; "same thing faster" as grind.
   At least one obstacle MUST have introAtLevel 1.

4. PHYSICS SAFETY. The jump peaks at roughly jumpVelocity² / (2·gravity) pixels.
   With the defaults (-620 / 1750) that is about 110px. Every obstacle's
   yOffset + motionAmp + height must stay well under that or it is unclearable.
   Keep tall_block height <= 65 and flying_drone yOffset <= 48.

5. LOW BARS. A low_bar is passed by NOT jumping, so its yOffset must exceed the
   player's height (size × 0.82, so >= 60 with the default size 44).

6. CONTRAST. player and obstacle colours must be instantly readable against both
   bg and ground at high speed. Dark bg, bright player, clearly different
   obstacle hue. Never make obstacle a near-neighbour of ground.

7. COPY. Exactly 20 level names, escalating in intensity, themed to the setting.
   Never reference an existing commercial game in any string.

Respond only by calling emit_game_config.`;

function fewShotUser(prompt, intent) {
  return `Prompt: "${prompt}"

Classified intent:
  subject: ${intent.subject}
  setting: ${intent.theme?.setting}
  mood: ${intent.theme?.mood}
  palette hint: ${intent.theme?.paletteHint}
  difficulty bias: ${intent.difficultyBias}
  explicit requests: ${intent.explicitRequests?.length ? intent.explicitRequests.join(', ') : 'none'}

Reference palettes that are known to have good contrast in this engine (you may
adapt or replace them, but match this level of contrast):
${PALETTES.slice(0, 6)
  .map((p) => `  ${p.id}: bg ${p.palette.bg}, ground ${p.palette.ground}, player ${p.palette.player}, obstacle ${p.palette.obstacle}, accent ${p.palette.accent}`)
  .join('\n')}

Design the config.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function classifyWithLlm(prompt, usage) {
  const { input, usage: u } = await callTool({
    model: MODELS.classify,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: 'user', content: `Prompt: "${prompt}"` }],
    tool: CLASSIFY_TOOL,
    maxTokens: 1024,
    temperature: 0,
  });
  usage.push({ stage: 'classify', ...u, costUsd: estimateCostUsd(u) });
  return input;
}

async function configWithLlm(prompt, intent, usage) {
  const messages = [{ role: 'user', content: fewShotUser(prompt, intent) }];
  let lastErrors = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const { input, usage: u } = await callTool({
      model: MODELS.config,
      system: CONFIG_SYSTEM,
      messages,
      tool: EMIT_CONFIG_TOOL,
      maxTokens: 8192,
      temperature: attempt === 0 ? 1 : 0.4,
    });
    usage.push({ stage: `config#${attempt}`, ...u, costUsd: estimateCostUsd(u) });

    const candidate = assembleConfig(input, prompt, intent);
    const parsed = safeParseGameConfig(candidate);
    if (parsed.ok) return { config: parsed.config, attempts: attempt + 1 };

    lastErrors = parsed.errors;
    // §B3 repair: hand the exact validation errors back to the model
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${attempt}`, name: EMIT_CONFIG_TOOL.name, input }] });
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `t${attempt}`,
          is_error: true,
          content:
            `The config failed validation:\n${lastErrors.map((e) => `  - ${e}`).join('\n')}\n\n` +
            `Fix ONLY these problems and call emit_game_config again.`,
        },
      ],
    });
  }

  const e = new Error(`config validation failed after repair attempts: ${lastErrors?.join('; ')}`);
  e.code = 'CONFIG_UNREPAIRABLE';
  throw e;
}

/** Merge the model's design decisions with server-owned fields. */
function assembleConfig(modelInput, prompt, intent) {
  const gameId = hashSeed(prompt).toString(36);
  const seed = hashSeed(`${prompt}:${gameId}`) >>> 0;
  return clampNumbers({
    schemaVersion: 1,
    genre: 'endless_runner',
    ...modelInput,
    meta: {
      ...modelInput.meta,
      // never let the model choose these — they must be structurally valid
      packageId: packageIdFor(gameId),
      seed,
    },
    theme: { ...modelInput.theme, spritePack: null },
    player: { hitboxScale: 0.82, ...modelInput.player },
    progression: {
      levels: 20,
      mode: 'hybrid',
      endlessUnlockAt: 20,
      reliefLevels: [8, 15],
      ...(modelInput.progression ?? {}),
    },
  });
}

/**
 * Main entry. Never throws for model problems — only for a blocked prompt.
 * @param {string} prompt
 * @param {{forceDeterministic?:boolean, gameId?:string, seed?:number}} [opts]
 */
export async function plan(prompt, opts = {}) {
  const usage = [];
  const notes = [];

  const block = checkBlocked(prompt);
  if (block.blocked) {
    const e = new Error(block.reason);
    e.code = 'PROMPT_BLOCKED';
    throw e;
  }

  // The LLM path only knows how to design endless_runner configs today, so an explicit
  // genre request always takes the deterministic route rather than silently producing the
  // wrong genre.
  const genreRequested = opts.genre && opts.genre !== 'endless_runner';
  const useLlm = !opts.forceDeterministic && !genreRequested && hasApiKey();
  if (!useLlm) {
    const out = planDeterministic(prompt, opts);
    const note = genreRequested
      ? `${opts.genre} uses the rule-based planner`
      : hasApiKey()
        ? 'deterministic mode forced'
        : 'no ANTHROPIC_API_KEY — deterministic mode';
    return { ...out, usage, notes: [note] };
  }

  let intent;
  try {
    intent = await classifyWithLlm(prompt, usage);
    if (intent.blocked) {
      const e = new Error(intent.blockedReason || 'Prompt blocked by content policy');
      e.code = 'PROMPT_BLOCKED';
      throw e;
    }
  } catch (err) {
    if (err.code === 'PROMPT_BLOCKED') throw err;
    notes.push(`classifier failed (${err.message}) — using keyword classifier`);
    intent = classifyDeterministic(prompt);
  }

  try {
    const { config, attempts } = await configWithLlm(prompt, intent, usage);
    if (attempts > 1) notes.push(`config needed ${attempts} attempts (schema repair)`);
    return { config, intent, source: 'llm', usage, notes };
  } catch (err) {
    notes.push(`config generation failed (${err.message}) — falling back to deterministic planner`);
    const out = planDeterministic(prompt, { ...opts, intent: { ...intent, _paletteId: selectPalette(prompt).id } });
    return { ...out, usage, notes };
  }
}

/**
 * §B7 Refinement — emit a minimal JSON Patch instead of regenerating.
 * ~$0.005 and <2s per tweak, and it preserves everything the user already liked.
 *
 * Falls back to the deterministic refiner when there is no API key, so this feature
 * works for free users rather than being paywalled by accident.
 */
export async function refine(config, instruction, opts = {}) {
  if (opts.forceDeterministic || !hasApiKey()) {
    return refineDeterministic(config, instruction);
  }
  const usage = [];
  const { input, usage: u } = await callTool({
    model: MODELS.config,
    system:
      `You adjust an existing endless-runner config. Emit the MINIMAL RFC-6902 patch ` +
      `that satisfies the user's request. Change nothing else. Respect these ranges: ` +
      `startSpeed 140-420, maxSpeed 430-1150, spawnGapStart 900-2600, spawnGapEnd 420-880, ` +
      `gravity 700-3200, jumpVelocity -1200..-260. maxSpeed must stay above startSpeed and ` +
      `spawnGapEnd below spawnGapStart.`,
    messages: [
      {
        role: 'user',
        content: `Current config:\n${JSON.stringify(config, null, 1)}\n\nRequested change: "${instruction}"`,
      },
    ],
    tool: PATCH_TOOL,
    maxTokens: 2048,
    temperature: 0.2,
  });
  usage.push({ stage: 'refine', ...u, costUsd: estimateCostUsd(u) });

  const patched = applyPatch(structuredClone(config), input.patch || []);
  const parsed = safeParseGameConfig(clampNumbers(patched));
  if (!parsed.ok) {
    const e = new Error(`patch produced an invalid config: ${parsed.errors.join('; ')}`);
    e.code = 'PATCH_INVALID';
    throw e;
  }
  return { config: parsed.config, summary: input.summary, patch: input.patch, usage, source: 'llm' };
}

/** Rule-based refinement. Same output contract as the LLM path. */
export function refineDeterministic(config, instruction) {
  const { patch, summary, matched } = planRefinement(config, instruction);
  if (!matched) {
    const e = new Error(
      `I didn't understand "${instruction}". Try: ${REFINE_EXAMPLES.slice(0, 4).join(', ')}.`
    );
    e.code = 'REFINE_NOT_UNDERSTOOD';
    e.statusCode = 400;
    e.examples = REFINE_EXAMPLES;
    throw e;
  }
  const patched = applyPatch(structuredClone(config), patch);
  const parsed = safeParseGameConfig(clampNumbers(patched));
  if (!parsed.ok) {
    const e = new Error(`patch produced an invalid config: ${parsed.errors.join('; ')}`);
    e.code = 'PATCH_INVALID';
    throw e;
  }
  return { config: parsed.config, summary, patch, usage: [], source: 'deterministic' };
}

/** Minimal RFC-6902 subset: replace / add / remove. */
export function applyPatch(target, patch) {
  for (const op of patch) {
    const parts = op.path.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!parts.length) continue;
    let node = target;
    for (const p of parts.slice(0, -1)) {
      if (node == null) break;
      node = Array.isArray(node) ? node[Number(p)] : node[p];
    }
    if (node == null) continue;
    const key = parts.at(-1);
    const idx = Array.isArray(node) ? Number(key) : key;
    if (op.op === 'remove') {
      if (Array.isArray(node)) node.splice(idx, 1);
      else delete node[idx];
    } else {
      node[idx] = op.value;
    }
  }
  return target;
}
