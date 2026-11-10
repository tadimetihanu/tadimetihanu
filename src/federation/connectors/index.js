const { BaseConnector } = require('./BaseConnector');
const { S3Connector } = require('./S3Connector');
const { AdlsConnector } = require('./AdlsConnector');
const { MinioConnector } = require('./MinioConnector');
const { PostgresConnector } = require('./PostgresConnector');
const { MysqlConnector } = require('./MysqlConnector');

function createConnector(catalogConfig = {}) {
    const type = String(catalogConfig.source_type || catalogConfig.sourceType || '').toLowerCase().trim();
    switch (type) {
        case 's3':
        case 'aws_s3':
        case 'iceberg':
            return new S3Connector(catalogConfig);
        case 'adls':
        case 'azure':
        case 'azure_adls':
        case 'adls_gen2':
            return new AdlsConnector(catalogConfig);
        case 'minio':
            return new MinioConnector(catalogConfig);
        case 'postgres':
        case 'postgresql':
            return new PostgresConnector(catalogConfig);
        case 'mysql':
            return new MysqlConnector(catalogConfig);
        default:
            throw new Error(`Unsupported federation connector source_type: '${type}'. Supported types: s3, adls, minio, postgresql, mysql`);
    }
}

module.exports = {
    BaseConnector,
    S3Connector,
    AdlsConnector,
    MinioConnector,
    PostgresConnector,
    MysqlConnector,
    createConnector
};

