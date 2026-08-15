
try {
    console.log("Checking modules...");
    require('openai');
    console.log("openai ok");
    require('duckdb');
    console.log("duckdb ok");
    require('@aws-sdk/client-s3');
    console.log("aws ok");
    require('@azure/storage-blob');
    console.log("azure ok");
    require('express');
    console.log("express ok");
    require('cors');
    console.log("cors ok");
    require('./src/drivers/storage');
    console.log("storage file ok");
    require('./src/query/engine');
    console.log("engine file ok");
    require('./src/query/ai');
    console.log("ai file ok");
    console.log("ALL MODULES OK");
} catch (e) {
    console.error("FAIL:", e.message, e.stack);
}
