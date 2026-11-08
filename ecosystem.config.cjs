module.exports = {
  apps: [
    {
      name: 'notion-hugo-pipeline',
      script: './worker.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 2000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: '300M',
      kill_timeout: 10000,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

