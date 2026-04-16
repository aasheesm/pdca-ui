module.exports = {
  apps: [{
    name: 'pdca-dashboard',
    script: 'server.js',
    cwd: '/root/projects/pdca',
    pre_start: 'node --check server.js',
    max_restarts: 5,
    min_uptime: 10000,
    max_memory_restart: '256M',           // restart before the OOM killer — cleaner than SIGKILL mid-request
    exp_backoff_restart_delay: 100,       // 100ms, 200ms, 400ms, ... prevents restart-storm CPU spin
    kill_timeout: 5000,                   // let in-flight requests finish on reload
    listen_timeout: 10000,                // grace period before PM2 flags a restart as failed
    merge_logs: true,
    env: {
      NODE_ENV: 'production',
      PORT: 7010,
      // LISTEN_HOST defaults to 127.0.0.1 in server.js; set to 0.0.0.0 only if intentional.
    }
  }]
};
