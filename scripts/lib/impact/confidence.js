/**
 * Impact confidence — separate from risk.
 * confidence >= 0.90 → targeted verification
 * 0.75..0.90 → wider verification
 * < 0.75 → strict / full tests / dual review
 */
export const CONFIDENCE_THRESHOLDS = Object.freeze({
  targeted: 0.9,
  wider: 0.75,
});

export function computeConfidence({
  gitOk = true,
  unsupportedFiles = 0,
  totalFiles = 0,
  cacheComplete = true,
  parseErrors = 0,
  hasDiff = true,
} = {}) {
  let score = 1;
  if (!gitOk) score -= 0.5;
  if (!hasDiff) score -= 0.1;
  if (totalFiles > 0 && unsupportedFiles > 0) {
    score -= Math.min(0.4, (unsupportedFiles / totalFiles) * 0.5);
  }
  if (!cacheComplete) score -= 0.05;
  if (parseErrors > 0) score -= Math.min(0.3, parseErrors * 0.05);
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

export function verificationModeForConfidence(confidence) {
  if (confidence >= CONFIDENCE_THRESHOLDS.targeted) return "targeted";
  if (confidence >= CONFIDENCE_THRESHOLDS.wider) return "wider";
  return "strict";
}
