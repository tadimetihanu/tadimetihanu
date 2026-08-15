import sys, json
try:
    from pymilvus import MilvusClient
    client = MilvusClient('./milvus.db')
    client.query(collection_name='unstructured_rag', filter='text LIKE "%Bronze%"', output_fields=['text', 'source'], limit=5)
    print("Success")
except Exception as e:
    print(repr(e))
    print('str(e):', str(e))
