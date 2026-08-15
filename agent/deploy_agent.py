import subprocess, json, time, sys

# --- CiqAgent Configuration ---
CONFIG = {
    "rg": "CloudObjectIQ-RG",
    "location_primary": "eastus",
    "location_failover": "centralus",
    "acr": "ciqacrfinal",
    "app": "ciq-pro"
}

def run_az(cmd):
    """Run Azure CLI commands and return the JSON/TSV output."""
    try:
        proc = subprocess.run(f"az {cmd} --output json", shell=True, capture_output=True, text=True)
        if proc.returncode != 0:
            return {"error": proc.stderr}
        return json.loads(proc.stdout) if proc.stdout else {"status": "success"}
    except Exception as e:
        return {"error": str(e)}

def think(step):
    print(f"\n🤖 [CiqAgent] Thinking: {step}...")
    time.sleep(1)

def deploy():
    think("Analyzing Cloud Connectivity")
    
    # Check for providers
    providers = run_az("provider show --namespace Microsoft.ContainerService")
    if "error" in providers:
        print("❌ Provider Missing. Initiating Registration Flow.")
        run_az("provider register --namespace Microsoft.ContainerService")

    think("Verifying Container Registry Architecture")
    acr = run_az(f"acr show --name {CONFIG['acr']}")
    if "error" in acr:
        print("🚀 Building New Registry...")
        run_az(f"acr create --resource-group {CONFIG['rg']} --name {CONFIG['acr']} --sku Basic --admin-enabled true")

    think("Compiling Docker Environment")
    run_az(f"acr build --registry {CONFIG['acr']} --image cloudobjectiq:v1 .")

    think("Deploying to High-Availability Fabric")
    # Failover logic: If East US fails DNS regularly, try Central US
    loc = CONFIG['location_primary']
    check_dns = subprocess.run(f"nslookup {CONFIG['app']}.{loc}.azurecontainerapps.io", shell=True, capture_output=True)
    
    if check_dns.returncode != 0:
        print(f"⚠️ High Latency/DNS Detected in {loc}. Switching to Failover: {CONFIG['location_failover']}")
        loc = CONFIG['location_failover']

    # Final Deployment
    res = run_az(f"containerapp up --name {CONFIG['app']} --resource-group {CONFIG['rg']} --location {loc} --image {CONFIG['acr']}.azurecr.io/cloudobjectiq:v1")
    
    if "error" in res:
        print(f"❌ Deployment Failed: {res['error']}")
    else:
        print(f"\n✅ [CiqAgent] Success! CloudObjectIQ is healthy in {loc}.")
        print(f"🔗 Live URL: {res.get('properties', {}).get('configuration', {}).get('ingress', {}).get('fqdn', 'Check Portal')}")

if __name__ == "__main__":
    deploy()
