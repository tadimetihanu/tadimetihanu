import os
import s3fs
import pyarrow.orc as orc

# Ensure TZDIR is set for pyarrow on Windows
import site
tzdir = os.path.join(site.getsitepackages()[-1], 'tzdata', 'zoneinfo')
os.environ['TZDIR'] = tzdir

print("Connecting to MinIO...")
fs = s3fs.S3FileSystem(
    endpoint_url="http://localhost:9000",
    key="minioadmin",
    secret="minioadmin",
    client_kwargs={"region_name": "us-east-1"}
)

path = "datalake/performance_1m.orc"
print(f"Reading ORC file from: {path}")

with fs.open(path, 'rb') as f:
    orc_file = orc.ORCFile(f)
    print("\n--- TRUE ORC SCHEMA ---")
    print(orc_file.schema)
    print("\n--- FIRST 5 ROWS ---")
    df = orc_file.read().to_pandas()
    print(df.head())
    print(f"\nTotal rows in file: {len(df)}")
