const http = require('http');
const jwt = require('jsonwebtoken');

const token = jwt.sign({email:'admin@cloudobjectiq.com', role:'admin'}, 'changeme_plz_enterprise_grade', {expiresIn:'24h'});
const postData = JSON.stringify({ question: 'Bronze', mode: 'keyword' });

const options = {
  hostname: '127.0.0.1',
  port: 3001,
  path: '/api/rag/query',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token,
    'Content-Length': Buffer.byteLength(postData)
  }
};

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    console.log(`BODY: ${chunk}`);
  });
  res.on('end', () => {
    console.log('No more data in response.');
  });
});

req.on('error', (e) => {
  console.error(`problem with request: ${e.message}`);
});

req.write(postData);
req.end();
