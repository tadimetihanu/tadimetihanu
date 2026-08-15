param (
    [string]$ResourceGroupName = 'CloudObjectIQ-RG',
    [string]$Location = 'eastus',
    [string]$AcrName = 'ciqacr' + (Get-Random -Minimum 1000 -Maximum 9999)
)

Write-Host '[CloudObjectIQ] Starting Azure Cloud Deployment...' -ForegroundColor Cyan

# 1. Resource Group
Write-Host 'Target Resource Group: ' + $ResourceGroupName
az group create --name $ResourceGroupName --location $Location

# 2. Registry & Build
Write-Host 'Building Container Metadata...'
az acr create --resource-group $ResourceGroupName --name $AcrName --sku Basic --admin-enabled true
az acr build --registry $AcrName --image cloudobjectiq:v1 .

$AcrPass = az acr credential show --name $AcrName --query 'passwords[0].value' --output tsv

# 3. Infrastructure
Write-Host 'Provisioning Enterprise Environment...'
az deployment group create --resource-group $ResourceGroupName --template-file './infra/deploy-azure.bicep' --parameters acrName=$AcrName acrPassword=$AcrPass

Write-Host 'CloudObjectIQ is now LIVE on Azure!' -ForegroundColor Green
