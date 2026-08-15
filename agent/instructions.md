# 🤖 CloudObjectIQ: AI Deployment Agent (CiqAgent)

This agent is an **autonomous orchestration Layer** for your production analytics. It handles all the "Hardware" and "Network" heavy lifting so you only focus on the analytics.

---

### 🛡️ How to use the Agent:
1.  **Direct Execution**: Run `python ./agent/deploy_agent.py` in your terminal.
2.  **Autonomic Failover**: If the agent detects that `eastus` (East US) DNS is failing or slow, it will automatically pivot and deploy your high-performance container to `centralus` (Central US) or `westus` (West US).
3.  **Self-Audit**: Before every deployment, it checks:
    *   **Provider Registration**: Ensures all Kubernetes/ACA features are active.
    *   **ACR Integration**: Verifies that your private container registry is healthy.
    *   **Health Handshake**: Only marks as "Success" once the FQDN is reachable.

---

### 🚀 Future Capabilities for CiqAgent:
*   [ ] **Auto-TLS**: Automatic SSL certificate rotation.
*   [ ] **Cost Opt**: Automatically scale pods to 0 at night to save money.
*   [ ] **Anomaly Watch**: Alert when DuckDB query CPU usage spikes across pods.

---

### 📈 Current Agent Configuration:
*   **Target RG**: `CloudObjectIQ-RG`
*   **Failover Logic**: `East US` -> `Central US`
*   **Engine**: `Standard_DS2_v2` (Performance Grade)
