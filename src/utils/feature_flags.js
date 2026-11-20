/**
 * CloudObjectIQ - Feature Flags Configuration
 * Centralized toggles for experimental, distributed, and multi-engine capabilities.
 * 
 * Safe Default Principle:
 * - All distributed query execution (DQE) and Apache Doris capabilities remain DISABLED by default.
 * - Enabling requires explicit environment variable activation or administrative runtime override.
 */

const flags = {
  // Master toggle for Apache Doris SQL execution engine
  ENABLE_DORIS_ENGINE: process.env.ENABLE_DORIS_ENGINE === 'true',

  // Master toggle for Distributed Query Execution orchestration
  ENABLE_DQE: process.env.ENABLE_DQE === 'true',

  // Master toggle for Intelligent AUTO routing between engines
  ENABLE_AUTO_ROUTING: process.env.ENABLE_AUTO_ROUTING === 'true',

  // Master toggle for Doris Backend autoscaling
  ENABLE_DORIS_AUTOSCALING: process.env.ENABLE_DORIS_AUTOSCALING === 'true',

  // Query plan explanation and AST stage inspection
  ENABLE_EXECUTION_PLAN_UI: process.env.ENABLE_EXECUTION_PLAN_UI !== 'false', // Enabled for DuckDB/Spark/Doris

  // Distributed cluster monitoring telemetry
  ENABLE_DQE_MONITORING: process.env.ENABLE_DQE_MONITORING === 'true'
};

/**
 * Get current state of a feature flag
 * @param {string} flagName 
 * @returns {boolean}
 */
function isFeatureEnabled(flagName) {
  if (flagName in flags) {
    return flags[flagName];
  }
  return false;
}

/**
 * Set a feature flag at runtime (useful for testing or administrative enablement)
 * @param {string} flagName 
 * @param {boolean} value 
 */
function setFeatureFlag(flagName, value) {
  flags[flagName] = Boolean(value);
}

/**
 * Get all current feature flag values
 * @returns {Record<string, boolean>}
 */
function getAllFeatureFlags() {
  return { ...flags };
}

module.exports = {
  isFeatureEnabled,
  setFeatureFlag,
  getAllFeatureFlags,
  flags
};
