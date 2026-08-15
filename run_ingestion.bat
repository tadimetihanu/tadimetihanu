@echo off
echo Starting Spark Ingestion Layer...
echo Usage: run_ingestion.bat ^<path_to_file^> ^<csv^|json^|parquet^|orc^>

if "%~1"=="" (
    echo Error: Missing file path.
    exit /b 1
)

if "%~2"=="" (
    echo Error: Missing file type.
    exit /b 1
)

set HADOOP_HOME=%CD%\hadoop
set JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-25.0.3.9-hotspot
set PATH=%JAVA_HOME%\bin;%HADOOP_HOME%\bin;%PATH%

REM We must provide the necessary packages to spark-submit or python to connect to MinIO/MySQL
echo Submitting to Spark (via Python)...
python src\jobs\spark_ingestion_layer.py "%~1" "%~2"
echo Done!
