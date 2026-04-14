module.exports = {
  apps: [{
    name: 'pdca-dashboard',
    script: 'server.js',
    cwd: '/root/projects/pdca-ui',
    pre_start: 'node --check server.js',
    max_restarts: 5,
    min_uptime: 10000,
    env: {
      NODE_ENV: 'production',
      PORT: 7010
    }
  }]
};
