from pymilvus import MilvusClient
client = MilvusClient('./data/milvus.db')
client.load_collection('unstructured_rag')
res = client.query(collection_name='unstructured_rag', filter='text LIKE "%Bronze%"', output_fields=['text', 'source'])
print(f'Found {len(res)} results')
