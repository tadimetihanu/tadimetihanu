const { S3Connector } = require('./S3Connector');

class MinioConnector extends S3Connector {
    constructor(catalogConfig = {}) {
        super({ ...catalogConfig, source_type: 'minio' });
    }

    getCapabilities() {
        return {
            sourceType: 'minio',
            providerName: 'MinIO Object Storage',
            supportsPredicatePushdown: true,
            supportsProjectionPushdown: true,
            supportsLimitPushdown: true,
            supportsAggregationPushdown: false,
            supportsJoinPushdown: false,
            supportsDynamicFiltering: true,
            supportsIceberg: true,
            supportedFormats: ['parquet', 'iceberg', 'csv', 'json'],
            isRelational: false,
            isObjectStorage: true,
            costModel: 'CLOUD_OBJECT_SCAN_USD_PER_TIB',
            rateUsdPerTib: 5.0
        };
    }
}

module.exports = { MinioConnector };

