param location string = resourceGroup().location
param acrName string
param acrPassword string

resource env 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: 'ca-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: law.properties.customerId
        sharedKey: law.listKeys().primarySharedKey
      }
    }
  }
}

resource law 'Microsoft.OperationalInsights/workspace@2022-10-01' = {
  name: 'log-analytics'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
  }
}

resource app 'Microsoft.App/containerApps@2023-05-01' = {
  name: 'cloudobjectiq-service'
  location: location
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
      }
      registries: [
        {
          server: '${acrName}.azurecr.io'
          username: '${acrName}'
          passwordSecretRef: 'acr-pass'
        }
      ]
      secrets: [
        {
          name: 'acr-pass'
          value: acrPassword
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'cloudobject-app'
          image: '${acrName}.azurecr.io/cloudobjectiq:v1'
          resources: { cpu: json('0.5'), memory: '1.0Gi' }
        },
        {
          name: 'minio-storage'
          image: 'minio/minio:latest'
          args: [ 'server', '/data', '--console-address', ':9001' ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
