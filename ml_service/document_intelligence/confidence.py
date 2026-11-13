import math
import numpy as np
from typing import List, Dict, Any

def calibrate_confidence(raw_score: float, min_val: float = 0.0, max_val: float = 1.0) -> float:
    """
    Normalizes and calibrates raw prediction scores to a 0.0 - 100.0 scale
    using temperature scaling sigmoid.
    """
    if math.isnan(raw_score) or math.isinf(raw_score):
        return 50.0

    # Clip to valid range
    val = max(min_val, min(max_val, raw_score))
    # Normalized 0.0 to 1.0
    norm = (val - min_val) / max(1e-6, max_val - min_val)
    # Apply soft sigmoid calibration
    calibrated = 100.0 / (1.0 + math.exp(-6.0 * (norm - 0.5)))
    return round(float(calibrated), 2)

def calculate_entropy_confidence(probabilities: List[float]) -> float:
    """
    Calculates prediction confidence based on normalized Shannon entropy.
    Low entropy -> High confidence.
    """
    if not probabilities or len(probabilities) <= 1:
        return 95.0

    probs = np.array(probabilities, dtype=float)
    probs = probs / max(1e-6, np.sum(probs))
    probs = np.clip(probs, 1e-12, 1.0)

    max_entropy = math.log(len(probs))
    actual_entropy = -float(np.sum(probs * np.log(probs)))
    norm_entropy = actual_entropy / max(1e-6, max_entropy)

    confidence = (1.0 - norm_entropy) * 100.0
    return round(max(10.0, min(99.9, confidence)), 2)
