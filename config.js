// config.js - Configuration for ComfyClaw

module.exports = {
  servers: [
    // Add more servers here, it will automatically select the server with the lowest queue size
    "http://localhost:8188"
  ],
  aws: {
    enabled: false, // Set to true to upload outputs to S3, can also pull from ~/.aws/credentials
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || "us-east-1",
    bucket: process.env.S3_BUCKET,
    prefix: "", // Optional key prefix, e.g. "outputs/"
  },
};
