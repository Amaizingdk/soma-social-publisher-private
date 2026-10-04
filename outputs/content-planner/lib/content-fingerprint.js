'use strict';

const { createHash } = require('node:crypto');

function fingerprintForContent({ platformCopies, assetId, season, warnings, instructorOptions }) {
  const options = instructorOptions && Object.fromEntries(Object.entries(instructorOptions).map(([key, option]) => [key, {
    instructor: option.instructor,
    warnings: option.warnings,
    platformCopies: option.platformCopies,
    assetId: option.assetId,
  }]));
  return createHash('sha256').update(JSON.stringify({
    platformCopies, assetId, season, warnings, instructorOptions: options,
  })).digest('hex');
}

module.exports = { fingerprintForContent };
