const fs = require('fs');
const jwt = require('jsonwebtoken');

const token = jwt.sign({email:'admin@cloudobjectiq.com', role:'admin'}, 'changeme_plz_enterprise_grade', {expiresIn:'24h'});

const form = new FormData();
form.append('password', 'admin');
form.append('file', new Blob([fs.readFileSync('test_enc.pdf')]), 'test_enc.pdf');

fetch('http://localhost:3001/api/rag/upload_and_index', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
    body: form
}).then(res => res.text()).then(text => console.log(text)).catch(e => console.error(e));
