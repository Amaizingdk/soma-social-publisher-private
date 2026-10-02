const SOMA_REPOSITORY = 'Amaizingdk/soma-social-publisher-private';
const GITHUB_API_ROOT = 'https://api.github.com/repos/';
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH']);

function assertRelativeRepositoryPath(relativePath) {
  if (
    typeof relativePath !== 'string'
    || !relativePath.startsWith('/')
    || relativePath.startsWith('//')
    || relativePath.includes('\\')
    || relativePath.includes('\0')
    || relativePath.split(/[?#]/u, 1)[0].split('/').includes('..')
  ) {
    throw new Error('Der kræves en relativ GitHub-sti');
  }
}

function createGitHubClient({ repository, token, fetchImpl = globalThis.fetch }) {
  if (repository !== SOMA_REPOSITORY) {
    throw new Error('GitHub repository matcher ikke SOMA');
  }
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('GITHUB_TOKEN mangler');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('GitHub fetch mangler');
  }

  async function request(method, relativePath, body) {
    const normalizedMethod = String(method || '').toUpperCase();
    if (!ALLOWED_METHODS.has(normalizedMethod)) {
      throw new Error('GitHub-metoden er ikke tilladt');
    }
    assertRelativeRepositoryPath(relativePath);

    let response;
    try {
      response = await fetchImpl(GITHUB_API_ROOT + repository + relativePath, {
        method: normalizedMethod,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('GitHub API kunne ikke kontaktes');
    }

    if (!response?.ok) {
      throw new Error('GitHub API fejlede (HTTP ' + (response?.status || 'ukendt') + ')');
    }
    if (response.status === 204 || response.status === 205) return null;
    return response.json();
  }

  return { repository, request };
}

module.exports = {
  SOMA_REPOSITORY,
  createGitHubClient,
};
