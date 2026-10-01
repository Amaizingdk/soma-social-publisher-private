'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeIdentifier(value, fallback) {
  const cleaned = String(value || fallback).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || fallback).slice(0, 24);
}

function createDefaultRunGit(repoDir) {
  return (args, { allowExitCode } = {}) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repoDir, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const exitCode = Number.isInteger(error.code) ? error.code : 1;
        if (exitCode === allowExitCode) {
          resolve({ exitCode, stdout: String(stdout || ''), stderr: '' });
          return;
        }
        reject(new Error(`Git-kommando fejlede med exit ${exitCode}`));
        return;
      }
      resolve({ exitCode: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function createGitStateStore({ repoDir, ledgerPath, runId, runGit } = {}) {
  const root = path.resolve(repoDir || '');
  if (!repoDir || !path.isAbsolute(root)) throw new Error('Git-repository skal have en absolut sti');
  if (typeof ledgerPath !== 'string' || !ledgerPath.trim() || path.isAbsolute(ledgerPath)) {
    throw new Error('Ledger-stien skal være relativ til repository');
  }
  const resolvedLedger = path.resolve(root, ledgerPath);
  if (!isInside(root, resolvedLedger) || resolvedLedger === root) {
    throw new Error('Ledger-stien skal ligge i repository');
  }
  const relativeLedger = path.relative(root, resolvedLedger).split(path.sep).join('/');
  const git = runGit || createDefaultRunGit(root);
  if (typeof git !== 'function') throw new Error('runGit skal være en funktion');

  return {
    async persist({ phase, entry } = {}) {
      if (!['reserved', 'published', 'manual_review_required'].includes(phase)) {
        throw new Error('Ugyldig persistence-fase');
      }
      if (!entry || typeof entry.idempotencyKey !== 'string' || !entry.idempotencyKey.trim()) {
        throw new Error('Persistence kræver idempotencyKey');
      }
      if (!fs.existsSync(resolvedLedger) || !fs.statSync(resolvedLedger).isFile()) {
        throw new Error('Ledger-filen findes ikke i repository');
      }
      const shortKey = safeIdentifier(entry.idempotencyKey, 'delivery').slice(0, 16);
      const safeRunId = safeIdentifier(runId, 'local');
      const commitMessage = `state: ${phase} ${shortKey} run ${safeRunId}`;
      try {
        await git(['add', '--', relativeLedger]);
        const changed = await git(['diff', '--cached', '--quiet', '--', relativeLedger], { allowExitCode: 1 });
        if (changed.exitCode === 1) {
          await git(['commit', '-m', commitMessage]);
          await git(['push', 'origin', 'HEAD:main']);
        }
      } catch {
        throw new Error(`Git-persistence fejlede under ${phase}`);
      }
    },
  };
}

module.exports = { createDefaultRunGit, createGitStateStore };
