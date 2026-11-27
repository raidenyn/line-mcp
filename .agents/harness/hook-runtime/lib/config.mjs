// Generated from src/shared/lib/config.mts by scripts/build.mts. Do not edit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function readHarnessConfig(repoRoot) {
  const file = join(repoRoot, '.agents', 'harness.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new ConfigError(`cannot read ${file}: ${err.message}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err.message}`);
  }
  if (!isObject(value)) throw new ConfigError(`${file} must contain a JSON object`);
  return value;
}

export function loadSection(repoRoot, tool, { keys = [], required = [], defaults = {} } = {}) {
  const config = readHarnessConfig(repoRoot);
  const errors = [];
  let own = {};
  if (config[tool] !== undefined) {
    if (isObject(config[tool])) own = config[tool];
    else errors.push(`"${tool}" must be an object`);
  }
  for (const key of Object.keys(own)) {
    if (!keys.includes(key)) errors.push(`unknown key "${key}" in "${tool}" (allowed: ${keys.join(', ')})`);
  }
  for (const key of required) {
    if (own[key] === undefined) errors.push(`missing required key "${key}" in "${tool}"`);
  }
  return { section: { ...defaults, ...own }, errors };
}
