module.exports = {
    apps: [
        {
            name: "dealer-portal",
            script: "npm",
            args: "start",
            env: {
                NODE_ENV: "production"
            }
        }
    ]
};
