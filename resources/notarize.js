/**
 * macOS Notarization Configuration for META Mover
 * 
 * This file handles the notarization process for macOS builds to ensure
 * the application can run on macOS without security warnings.
 * 
 * Notarization requires:
 * 1. Apple Developer Account
 * 2. App-specific password or API key
 * 3. Valid code signing certificate
 * 
 * Environment variables required:
 * - APPLE_ID: Your Apple ID email
 * - APPLE_PASSWORD: App-specific password (recommended) 
 * - APPLE_TEAM_ID: Your team ID from Apple Developer account
 * 
 * Alternative API Key authentication:
 * - APPLE_API_KEY: Path to .p8 API key file
 * - APPLE_API_KEY_ID: API key ID
 * - APPLE_API_ISSUER: API key issuer ID
 */

const { notarize } = require('@electron/notarize');
const path = require('path');

/**
 * Notarize the macOS application
 * Called automatically by electron-builder after signing
 */
async function notarizeApp(context) {
    const { electronPlatformName, appOutDir } = context;
    
    // Only notarize macOS builds
    if (electronPlatformName !== 'darwin') {
        console.log('Skipping notarization - not a macOS build');
        return;
    }
    
    // Check for required environment variables
    const appleId = process.env.APPLE_ID;
    const applePassword = process.env.APPLE_PASSWORD;
    const appleTeamId = process.env.APPLE_TEAM_ID;
    
    // Alternative: API Key authentication
    const appleApiKey = process.env.APPLE_API_KEY;
    const appleApiKeyId = process.env.APPLE_API_KEY_ID;
    const appleApiIssuer = process.env.APPLE_API_ISSUER;
    
    // Check if we have credentials for notarization
    const hasAppleIdAuth = appleId && applePassword && appleTeamId;
    const hasApiKeyAuth = appleApiKey && appleApiKeyId && appleApiIssuer;
    
    if (!hasAppleIdAuth && !hasApiKeyAuth) {
        console.warn('⚠️  Skipping notarization - missing Apple credentials');
        console.log('   Set environment variables for notarization:');
        console.log('   Apple ID method:');
        console.log('   - APPLE_ID (your Apple ID email)');
        console.log('   - APPLE_PASSWORD (app-specific password)'); 
        console.log('   - APPLE_TEAM_ID (your team ID)');
        console.log('');
        console.log('   API Key method (recommended for CI):');
        console.log('   - APPLE_API_KEY (path to .p8 file)');
        console.log('   - APPLE_API_KEY_ID (API key ID)');
        console.log('   - APPLE_API_ISSUER (issuer ID)');
        return;
    }
    
    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(appOutDir, `${appName}.app`);
    
    console.log('🍎 Starting macOS notarization...');
    console.log(`   App: ${appPath}`);
    
    try {
        let notarizeOptions = {
            appBundleId: 'com.spacewelder314.metamover',
            appPath: appPath,
        };
        
        // Use API Key authentication if available (preferred for CI/CD)
        if (hasApiKeyAuth) {
            console.log('   Using Apple API Key authentication');
            notarizeOptions = {
                ...notarizeOptions,
                appleApiKey: appleApiKey,
                appleApiKeyId: appleApiKeyId,
                appleApiIssuer: appleApiIssuer,
            };
        } else {
            console.log('   Using Apple ID authentication');
            notarizeOptions = {
                ...notarizeOptions,
                appleId: appleId,
                appleIdPassword: applePassword,
                teamId: appleTeamId,
            };
        }
        
        await notarize(notarizeOptions);
        console.log('✅ macOS notarization completed successfully');
        
    } catch (error) {
        console.error('❌ macOS notarization failed:', error);
        
        // Provide helpful error context
        if (error.message.includes('invalid credentials')) {
            console.log('   Check your Apple credentials and try again');
        } else if (error.message.includes('uuid')) {
            console.log('   This may be a temporary Apple service issue - try again later');
        } else if (error.message.includes('timeout')) {
            console.log('   Notarization timed out - this can happen during high load periods');
        }
        
        throw error;
    }
}

/**
 * Alternative notarization function for different build systems
 * Can be called directly if not using electron-builder's afterSign hook
 */
async function notarizeManually(appPath, bundleId) {
    const appleId = process.env.APPLE_ID;
    const applePassword = process.env.APPLE_PASSWORD;
    const appleTeamId = process.env.APPLE_TEAM_ID;
    
    if (!appleId || !applePassword || !appleTeamId) {
        throw new Error('Missing required environment variables for notarization');
    }
    
    console.log('🍎 Manual notarization starting...');
    console.log(`   App: ${appPath}`);
    console.log(`   Bundle ID: ${bundleId}`);
    
    await notarize({
        appBundleId: bundleId,
        appPath: appPath,
        appleId: appleId,
        appleIdPassword: applePassword,
        teamId: appleTeamId,
    });
    
    console.log('✅ Manual notarization completed');
}

module.exports = {
    notarizeApp,
    notarizeManually,
};

// If running directly (for manual notarization)
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length >= 2) {
        const [appPath, bundleId] = args;
        notarizeManually(appPath, bundleId)
            .then(() => {
                console.log('Notarization completed successfully');
                process.exit(0);
            })
            .catch((error) => {
                console.error('Notarization failed:', error);
                process.exit(1);
            });
    } else {
        console.log('Usage: node notarize.js <app-path> <bundle-id>');
        console.log('Example: node notarize.js "dist/META Mover.app" "com.spacewelder314.metamover"');
        process.exit(1);
    }
}