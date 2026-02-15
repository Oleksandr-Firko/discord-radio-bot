const { spawnSync } = require('node:child_process');
const { generateDependencyReport } = require('@discordjs/voice');

function runPreflightChecks({ logger = console } = {}) {
  const report = generateDependencyReport();
  const issues = [];

  if (report.includes('- @snazzah/davey: not found')) {
    issues.push('Missing @snazzah/davey (required by @discordjs/voice for DAVE protocol).');
  }

  const hasNoNativeOpus = report.includes('- @discordjs/opus: not found');
  const hasNoScriptOpus = report.includes('- opusscript: not found');
  if (hasNoNativeOpus && hasNoScriptOpus) {
    issues.push('No Opus encoder found. Install @discordjs/opus or opusscript.');
  }

  const ffmpegCommand = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffmpegCheck = spawnSync(ffmpegCommand, ['-version'], { windowsHide: true });
  if (ffmpegCheck.error || ffmpegCheck.status !== 0) {
    const reason = ffmpegCheck.error?.message ?? `exit code ${ffmpegCheck.status}`;
    issues.push(`FFmpeg is unavailable (${ffmpegCommand}): ${reason}`);
  }

  if (!issues.length) {
    return;
  }

  logger.error('Dependency preflight failed:');
  for (const issue of issues) {
    logger.error(`- ${issue}`);
  }
  logger.error('\nDependency report:\n' + report);
  throw new Error('Preflight checks failed');
}

module.exports = { runPreflightChecks };
