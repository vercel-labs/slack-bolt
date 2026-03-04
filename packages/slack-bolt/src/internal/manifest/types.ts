export type Manifest = {
  display_information: {
    name: string;
    long_description?: string;
    description?: string;
    background_color?: string;
  };
  settings?: {
    event_subscriptions?: {
      request_url?: string;
      bot_events?: string[];
      user_events?: string[];
    };
    interactivity?: {
      is_enabled?: boolean;
      request_url?: string;
      message_menu_options_url?: string;
    };
    org_deploy_enabled?: boolean;
    socket_mode_enabled?: boolean;
    token_rotation_enabled?: boolean;
  };
  features?: {
    bot_user?: {
      display_name: string;
      always_online?: boolean;
    };
    slash_commands?: {
      command: string;
      url?: string;
      description: string;
      usage_hint?: string;
      should_escape?: boolean;
    }[];
  };
  oauth_config?: {
    scopes?: {
      bot?: string[];
      user?: string[];
    };
    redirect_urls?: string[];
    token_management_enabled?: boolean;
  };
};
