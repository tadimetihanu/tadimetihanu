import math
import numpy as np
from typing import Dict, Any, List

def evaluate_classification(y_true: List[str], y_pred: List[str], labels: List[str]) -> Dict[str, Any]:
    """Calculate Accuracy, Precision, Recall, Macro F1 for classification."""
    correct = sum(1 for yt, yp in zip(y_true, y_pred) if yt == yp)
    accuracy = correct / max(1, len(y_true))

    precisions, recalls, f1s = [], [], []
    for label in labels:
        tp = sum(1 for yt, yp in zip(y_true, y_pred) if yt == label and yp == label)
        fp = sum(1 for yt, yp in zip(y_true, y_pred) if yt != label and yp == label)
        fn = sum(1 for yt, yp in zip(y_true, y_pred) if yt == label and yp != label)

        p = tp / max(1, tp + fp) if (tp + fp) > 0 else 0.0
        r = tp / max(1, tp + fn) if (tp + fn) > 0 else 0.0
        f1 = (2 * p * r) / max(1e-6, p + r) if (p + r) > 0 else 0.0

        precisions.append(p)
        recalls.append(r)
        f1s.append(f1)

    return {
        "accuracy": round(accuracy * 100, 2),
        "macro_precision": round(float(np.mean(precisions)) * 100, 2),
        "macro_recall": round(float(np.mean(recalls)) * 100, 2),
        "macro_f1": round(float(np.mean(f1s)) * 100, 2),
        "sample_count": len(y_true)
    }

def evaluate_ner(extracted_entities: List[Dict[str, Any]], gold_entities: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Calculate Entity-level Precision, Recall, and F1."""
    # Matches based on (entity_type, normalized_value)
    gold_set = {(e["entity_type"].upper(), e["entity_value"].strip().lower()) for e in gold_entities}
    pred_set = {(e["entity_type"].upper(), e["entity_value"].strip().lower()) for e in extracted_entities}

    tp = len(gold_set.intersection(pred_set))
    fp = len(pred_set - gold_set)
    fn = len(gold_set - pred_set)

    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    f1 = (2 * precision * recall) / max(1e-6, precision + recall)

    return {
        "entity_precision": round(precision * 100, 2),
        "entity_recall": round(recall * 100, 2),
        "entity_f1": round(f1 * 100, 2),
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn
    }

def evaluate_reranking(ranked_ids: List[str], relevant_ids: List[str], k: int = 10) -> Dict[str, Any]:
    """Calculate Recall@K, MRR, and NDCG@10."""
    # Recall@K
    hits_at_k = sum(1 for rid in ranked_ids[:k] if rid in relevant_ids)
    recall_at_k = hits_at_k / max(1, len(relevant_ids))

    # MRR (Mean Reciprocal Rank)
    mrr = 0.0
    for idx, rid in enumerate(ranked_ids):
        if rid in relevant_ids:
            mrr = 1.0 / (idx + 1)
            break

    # NDCG@10
    dcg = 0.0
    for idx, rid in enumerate(ranked_ids[:k]):
        rel = 1.0 if rid in relevant_ids else 0.0
        dcg += rel / math.log2(idx + 2)

    idcg = sum(1.0 / math.log2(i + 2) for i in range(min(k, len(relevant_ids))))
    ndcg = (dcg / idcg) if idcg > 0 else 0.0

    return {
        "recall_at_k": round(recall_at_k * 100, 2),
        "mrr": round(mrr, 4),
        "ndcg_at_10": round(ndcg, 4),
        "k": k
    }

def evaluate_anomaly_detection(y_true: List[int], y_pred: List[int]) -> Dict[str, Any]:
    """Calculate Precision, Recall, and False-Positive Rate for anomaly flags."""
    # 1 is anomaly, 0 is normal
    tp = sum(1 for yt, yp in zip(y_true, y_pred) if yt == 1 and yp == 1)
    fp = sum(1 for yt, yp in zip(y_true, y_pred) if yt == 0 and yp == 1)
    fn = sum(1 for yt, yp in zip(y_true, y_pred) if yt == 1 and yp == 0)
    tn = sum(1 for yt, yp in zip(y_true, y_pred) if yt == 0 and yp == 0)

    precision = tp / max(1, tp + fp)
    recall = tp / max(1, tp + fn)
    f1 = (2 * precision * recall) / max(1e-6, precision + recall)
    fpr = fp / max(1, fp + tn)

    return {
        "precision": round(precision * 100, 2),
        "recall": round(recall * 100, 2),
        "f1_score": round(f1 * 100, 2),
        "false_positive_rate": round(fpr * 100, 2),
        "true_positives": tp,
        "false_positives": fp
    }
