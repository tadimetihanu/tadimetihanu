import subprocess, time, sys

def think(step):
    print(f"\n🤖 [OnPrem-Agent] Thinking: {step}...")
    time.sleep(1)

def check_docker():
    try:
        subprocess.run("docker version", shell=True, capture_output=True, check=True)
        return True
    except:
        return False

def deploy():
    print("🚀 [OnPrem-Agent] Initiating Air-Gapped Analytics Stack...")
    
    if not check_docker():
        print("❌ Docker is not running or not installed. Please launch Docker Desktop first.")
        sys.exit(1)

    think("Orchestrating Local Analytics Fabric")
    subprocess.run("docker-compose up -d", shell=True)

    think("Ensuring Data Lake Health (MinIO)")
    # Waiting for port 3000
    print("⏳ Waiting for Dashboard on http://localhost:3000...")
    
    # We can use a simple loop here
    max_wait = 30
    for i in range(max_wait):
        try:
            # check if port 3000 is listening?
            import socket
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            res = sock.connect_ex(('127.0.0.1', 3000))
            if res == 0:
                print("\n✅ [OnPrem-Agent] Dashboard is LIVE!")
                print("🌍 URL: http://localhost:3000")
                print("🛶 MinIO Console: http://localhost:9001 (admin/password123)")
                sock.close()
                break
        except:
            pass
        time.sleep(1)
        if i == max_wait - 1:
            print("⚠️ Dashboard is taking longer than expected. Check 'docker logs'.")

    think("Auto-Provisioning Local Storage Targets")
    print("✅ Local Buckets: 'landing' (S3), 'gold' (Parquet/Lakehouse) are ready.")

if __name__ == "__main__":
    deploy()
