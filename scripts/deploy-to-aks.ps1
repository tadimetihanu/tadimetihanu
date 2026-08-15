param (
    [string]$ResourceGroupName = 'CloudObjectIQ-RG',
    [string]$ClusterName = 'cloudobjectiq-aks',
    [string]$AcrName = 'ciqacr4781',
    [string]$Location = 'eastus'
)

Write-Host '[CloudObjectIQ] Starting High-Availability AKS Deployment...' -ForegroundColor Cyan

# 1. Create AKS Cluster (Managed Auto-scaler)
Write-Host 'Provisioning AKS Cluster & Cluster Autoscaler...'
az aks create --resource-group $ResourceGroupName --name $ClusterName --node-count 1 --node-vm-size Standard_DS2_v2 --location $Location --enable-cluster-autoscaler --min-count 1 --max-count 3 --attach-acr $AcrName

# 2. Get Kubernetes Credentials
Write-Host 'Configuring Local Context...'
az aks get-credentials --resource-group $ResourceGroupName --name $ClusterName --overwrite-existing

# 3. Deploy Enterprise Manifests
Write-Host 'Applying Horizontal Auto-Scaling Rules...'
kubectl apply -f ./k8s/deployment.yaml

Write-Host 'CloudObjectIQ is now UN-STOPPABLE on AKS!' -ForegroundColor Green
Write-Host 'Waiting for LoadBalancer IP...'
kubectl get service cloudobjectiq-service --watch
