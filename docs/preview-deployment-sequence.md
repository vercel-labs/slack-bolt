# @vercel/slack-bolt Preview Deployment Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    participant Dev as Developer
    participant Git as Git Repository
    participant Vercel as Vercel Build
    participant CLI as vercel-slack CLI
    participant SlackAPI as Slack API
    participant VercelAPI as Vercel API

    Dev->>Git: git push (feature branch)
    Git->>Vercel: Trigger preview build
    
    Vercel->>CLI: Run "vercel-slack build --cleanup"
    
    Note over CLI: Check environment (skip if production/dev/local)
    
    %% Token Validation
    rect rgb(240, 240, 255)
        Note over CLI,SlackAPI: Token Validation Phase
        CLI->>SlackAPI: auth.test (SLACK_CONFIGURATION_TOKEN)
        alt Token expired & refresh token available
            SlackAPI-->>CLI: Token invalid/expired
            CLI->>SlackAPI: tooling.tokens.rotate (SLACK_CONFIG_REFRESH_TOKEN)
            SlackAPI-->>CLI: New token + refresh token
            CLI->>VercelAPI: Save rotated tokens as env vars
        else Token valid
            SlackAPI-->>CLI: OK
        end
    end
    
    CLI->>VercelAPI: getProject (validate VERCEL_API_TOKEN)
    VercelAPI-->>CLI: Project details
    
    %% Cleanup Phase
    rect rgb(255, 245, 238)
        Note over CLI,VercelAPI: Cleanup Phase (--cleanup flag)
        CLI->>VercelAPI: getActiveBranches
        VercelAPI-->>CLI: Active branch list
        CLI->>VercelAPI: getEnvironmentVariables
        VercelAPI-->>CLI: Branch-scoped env vars
        
        loop For each orphaned branch
            CLI->>VercelAPI: getEnvironmentVariable (SLACK_APP_ID)
            VercelAPI-->>CLI: App ID
            CLI->>SlackAPI: apps.manifest.delete
            SlackAPI-->>CLI: App deleted
            CLI->>VercelAPI: Delete branch env vars
        end
    end
    
    %% Preview Provisioning
    rect rgb(240, 255, 240)
        Note over CLI,VercelAPI: Preview Provisioning Phase
        
        CLI->>CLI: Read manifest.json
        
        alt No bypass secret provided
            CLI->>VercelAPI: updateProtectionBypass
            VercelAPI-->>CLI: New bypass secret
        end
        
        CLI->>CLI: Rewrite manifest URLs → preview URL + bypass token
        CLI->>CLI: Update display name with branch info
        CLI->>CLI: Write updated manifest.json
        
        alt Existing SLACK_APP_ID
            CLI->>SlackAPI: apps.manifest.export (check if exists)
            alt App exists
                CLI->>SlackAPI: apps.manifest.update
                SlackAPI-->>CLI: Updated app
            else App not found
                CLI->>SlackAPI: apps.manifest.create
                SlackAPI-->>CLI: New app + credentials
            end
        else No existing app
            CLI->>SlackAPI: apps.manifest.create
            SlackAPI-->>CLI: New app + credentials
        end
    end
    
    %% Credential Storage (new apps only)
    rect rgb(255, 255, 240)
        Note over CLI,VercelAPI: Credential Storage (new apps only)
        alt New app created
            CLI->>VercelAPI: Add branch-scoped env vars
            Note over VercelAPI: SLACK_APP_ID<br/>SLACK_CLIENT_ID<br/>SLACK_CLIENT_SECRET<br/>SLACK_SIGNING_SECRET
        end
    end
    
    %% Auto-Install
    rect rgb(245, 240, 255)
        Note over CLI,SlackAPI: Auto-Install Phase
        alt SLACK_SERVICE_TOKEN provided
            CLI->>SlackAPI: apps.developerInstall
            alt Installation successful
                SlackAPI-->>CLI: Bot token + app-level token
                CLI->>VercelAPI: Add SLACK_BOT_TOKEN (branch-scoped)
            else Approval required
                SlackAPI-->>CLI: app_approval_request_*
                Note over CLI: Log warning - manual install needed
            end
        else No service token
            Note over CLI: Log warning - manual install needed
        end
    end
    
    %% Redeploy
    rect rgb(255, 240, 245)
        Note over CLI,VercelAPI: Redeploy Phase (new apps only)
        alt New app && deployment ID available
            CLI->>VercelAPI: createDeployment (forceNew)
            VercelAPI-->>CLI: New deployment ID + URL
            CLI->>VercelAPI: cancelDeployment (current)
            Note over Vercel: New deployment picks up env vars
        end
    end
    
    CLI-->>Vercel: Build continues (next build, etc.)
    Vercel-->>Dev: Preview deployment ready
    
    Note over Dev: Preview Slack app ready to test!
```

## Flow Summary

### 1. Token Validation
- Validates `SLACK_CONFIGURATION_TOKEN` via `auth.test`
- Auto-rotates expired tokens if `SLACK_CONFIG_REFRESH_TOKEN` is available

### 2. Cleanup (optional)
- Identifies orphaned preview branches (no longer active in Vercel)
- Deletes associated Slack apps via `apps.manifest.delete`
- Removes branch-scoped environment variables

### 3. Preview Provisioning
- Generates bypass secret for Vercel deployment protection
- Rewrites manifest URLs to point to preview deployment
- Creates or updates Slack app via manifest API

### 4. Credential Storage
- Stores app credentials as branch-scoped env vars:
  - `SLACK_APP_ID`
  - `SLACK_CLIENT_ID`
  - `SLACK_CLIENT_SECRET`
  - `SLACK_SIGNING_SECRET`

### 5. Auto-Install
- If `SLACK_SERVICE_TOKEN` is provided, auto-installs the app
- Stores `SLACK_BOT_TOKEN` as branch-scoped env var

### 6. Redeploy
- For new apps, triggers a redeploy to pick up new env vars
- Cancels the current deployment to avoid duplicate builds
