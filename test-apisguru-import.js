// Test script to import a small batch from APIs.guru
const axios = require('axios');

async function testImport() {
  try {
    console.log('Starting APIs.guru import test (10 APIs)...\n');
    
    const response = await axios.post('http://localhost:5000/api/import/apisguru', {
      maxApis: 10,
      skipExisting: true
    });
    
    console.log('Response:', response.data);
    console.log('\nImport started! Check the server logs for progress.');
    console.log('You can also check http://localhost:5000/api/stats to see the total count increase.');
    
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
  }
}

testImport();

