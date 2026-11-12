"""
Collapse 103 individually-registered MCP tools into 6 grouped meta-tools,
reducing the token schema footprint from ~15k to ~3k.
"""

GROUPS = {
    "workspace_gmail": [
        "search_gmail_messages",
        "get_gmail_message_content",
        "get_gmail_message_raw",
        "get_gmail_messages_content_batch",
        "send_gmail_message",
        "get_gmail_attachment_content",
        "get_gmail_thread_content",
        "modify_gmail_message_labels",
        "list_gmail_labels",
        "manage_gmail_label",
        "draft_gmail_message",
        "list_gmail_filters",
        "manage_gmail_filter",
        "get_gmail_threads_content_batch",
        "batch_modify_gmail_message_labels",
        "start_google_auth",
    ],
    "workspace_docs": [
        "get_doc_content",
        "create_doc",
        "modify_doc_text",
        "export_doc_to_pdf",
        "search_docs",
        "find_and_replace_doc",
        "list_docs_in_folder",
        "insert_doc_elements",
        "update_paragraph_style",
        "get_doc_as_markdown",
        "insert_doc_image",
        "update_doc_headers_footers",
        "batch_update_doc",
        "inspect_doc_structure",
        "create_table_with_data",
        "debug_table_structure",
        "list_document_comments",
        "manage_document_comment",
    ],
    "workspace_sheets": [
        "create_spreadsheet",
        "read_sheet_values",
        "modify_sheet_values",
        "list_spreadsheets",
        "get_spreadsheet_info",
        "format_sheet_range",
        "create_sheet",
        "list_spreadsheet_comments",
        "manage_spreadsheet_comment",
        "manage_conditional_formatting",
    ],
    "workspace_drive": [
        "search_drive_files",
        "get_drive_file_content",
        "get_drive_file_download_url",
        "create_drive_file",
        "create_drive_folder",
        "import_to_google_doc",
        "get_drive_shareable_link",
        "list_drive_items",
        "copy_drive_file",
        "update_drive_file",
        "manage_drive_access",
        "set_drive_file_permissions",
        "get_drive_file_permissions",
        "check_drive_file_public_access",
        "download_drive_folder_as_zip",
        "start_drive_unzip",
        "get_drive_unzip_status",
        "cancel_drive_unzip",
    ],
    "workspace_calendar": [
        "list_calendars",
        "get_events",
        "manage_event",
        "query_freebusy",
    ],
    "workspace_misc": [
        # Slides
        "create_presentation",
        "get_presentation",
        "batch_update_presentation",
        "get_page",
        "get_page_thumbnail",
        "list_presentation_comments",
        "manage_presentation_comment",
        # Chat
        "send_message",
        "get_messages",
        "search_messages",
        "create_reaction",
        "list_spaces",
        "download_chat_attachment",
        # Forms
        "create_form",
        "get_form",
        "list_form_responses",
        "set_publish_settings",
        "get_form_response",
        "batch_update_form",
        # Tasks
        "get_task",
        "list_tasks",
        "manage_task",
        "list_task_lists",
        "get_task_list",
        "manage_task_list",
        # Contacts
        "search_contacts",
        "get_contact",
        "list_contacts",
        "manage_contact",
        "list_contact_groups",
        "get_contact_group",
        "manage_contacts_batch",
        "manage_contact_group",
        # Search
        "search_custom",
        "get_search_engine_info",
        # Apps Script
        "list_script_projects",
        "get_script_project",
        "get_script_content",
        "create_script_project",
        "update_script_content",
        "run_script_function",
        "generate_trigger_code",
        "manage_deployment",
        "list_deployments",
        "delete_script_project",
        "list_versions",
        "create_version",
        "get_version",
        "list_script_processes",
        "get_script_metrics",
    ],
}


def _make_handler(dispatch_dict: dict, tool_description: str):
    async def handler(method: str, params: str = "{}") -> str:
        fn = dispatch_dict.get(method)
        if fn is None:
            available = sorted(dispatch_dict.keys())
            return f"Unknown method '{method}'. Available: {available}"
        import json
        return await fn(**json.loads(params))
    handler.__doc__ = tool_description
    return handler


def register_meta_tools(server):
    from core.tool_registry import get_tool_components

    components = get_tool_components(server)

    for group_name, method_names in GROUPS.items():
        # Only include methods that survived tier/permission filtering
        dispatch = {}
        for name in method_names:
            if name in components:
                obj = components[name]
                dispatch[name] = obj.fn if hasattr(obj, "fn") else obj

        if not dispatch:
            continue

        desc = (
            f"Google Workspace {group_name.replace('workspace_', '')} operations. "
            f"Methods: {', '.join(sorted(dispatch.keys()))}"
        )
        handler = _make_handler(dispatch, desc)
        handler.__name__ = group_name
        server.tool()(handler)

    # Remove all individual tools now that meta-tools are registered
    for name in list(components.keys()):
        try:
            server.local_provider.remove_tool(name)
        except Exception:
            pass
