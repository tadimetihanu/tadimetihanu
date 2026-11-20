# How to Deploy Apache Doris on Render

This guide explains how to deploy and connect **Apache Doris** to CloudObjectIQ on Render.

---

## Architecture on Render

```
  Internet
     │
     ▼
┌─────────────────────────────────┐
│ CloudObjectIQ Web Service       │ (Public Web Service)
│ app.cloudobjectiq.com           │
└────────────────┬────────────────┘
                 │ Internal Private Network (Private DNS)
                 ▼
┌─────────────────────────────────┐
│ doris-fe (Port 9030)            │ (Render Private Service)
│ apache/doris:2.1.2-fe-x86_64    │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ doris-be (Port 9050/8040)       │ (Render Private Service)
│ apache/doris:2.1.2-be-x86_64    │
└─────────────────────────────────┘
```

Render web services only expose **HTTP** (port 80/443) to the public internet.  
Because Doris communicates via the **MySQL wire protocol (port 9030)**, Doris must be deployed as a **Private Service** within your Render workspace so that CloudObjectIQ can connect to it securely over Render's private network.

---

## Step-by-Step Deployment via Render Dashboard

### Step 1: Create the Doris Frontend (FE) Service
1. Open your [Render Dashboard](https://dashboard.render.com).
2. Click **New +** (top right) and select **Private Service**.
3. Choose **Existing image** and enter:
   ```
   apache/doris:2.1.2-fe-x86_64
   ```
4. Name the service:
   ```
   doris-fe
   ```
5. Instance Type: Select **Standard** (2GB or 4GB RAM) — Doris Java Frontend requires at least 2GB RAM.
6. Under **Environment Variables**, add:
   * `FE_SERVICENAME` = `doris-fe`
   * `ENABLE_FQDN_MODE` = `true`
7. Click **Create Private Service**.

---

### Step 2: (Optional for Full Cluster) Create Doris Backend (BE) Service
1. Click **New +** ➔ **Private Service**.
2. Image: `apache/doris:2.1.2-be-x86_64`
3. Name: `doris-be`
4. Add environment variables:
   * `FE_SERVICENAME` = `doris-fe`
   * `FE_QUERY_PORT` = `9030`
   * `BE_ADDR` = `doris-be:9050`
5. Click **Create Private Service**.

---

### Step 3: Connect CloudObjectIQ to Doris
In your existing CloudObjectIQ service (`tadimetihanu`):
1. Go to **Environment** tab.
2. Add these variables:
   * `ENABLE_DORIS_ENGINE` = `true`
   * `ENABLE_DQE` = `true`
   * `DORIS_FE_HOST` = `doris-fe`   <-- *(Uses Render private service name, NOT 127.0.0.1)*
   * `DORIS_FE_PORT` = `9030`
3. Click **Save, rebuild, and deploy**.

Once deployed, CloudObjectIQ will communicate with `doris-fe:9030` over Render's internal mesh!
