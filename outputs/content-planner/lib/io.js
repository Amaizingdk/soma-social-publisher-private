'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function loadJsonValidated(filePath, validate) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${filePath} kunne ikke læses som JSON: ${error.message}`, { cause: error });
  }
  validate(value);
  return value;
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    JSON.parse(await fs.readFile(temporaryPath, 'utf8'));
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { loadJsonValidated, writeJsonAtomic };
