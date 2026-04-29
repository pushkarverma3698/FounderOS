import sys
import os
import plistlib
import subprocess

# Define the Shortcut name
SHORTCUT_NAME = "FounderOS_Intel"
DESKTOP_PATH = os.path.expanduser(f"~/Desktop/{SHORTCUT_NAME}.shortcut")

# Draft the Shortcut Plist structure
# Based on research of macOS 26 / 15.x Apple Intelligence identifiers
shortcut_data = {
    "WFWorkflowActions": [
        {
            "WFWorkflowActionIdentifier": "com.apple.appleintelligence.UseModelAction",
            "WFWorkflowActionParameters": {
                "Request": {"Value": {"Type": "ExtensionInput"}},
                "ShowInApp": False
            }
        },
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions.stop",
            "WFWorkflowActionParameters": {
                "WFOutput": {"Value": {"Type": "ActionOutput", "ActionIndex": 0}}
            }
        }
    ],
    "WFWorkflowInputContentItemClasses": [
        "WFSimpleTextContentItem"
    ],
    "WFWorkflowImportQuestions": [],
    "WFWorkflowTypes": ["QuickActions"],
    "WFWorkflowIcon": {
        "WFWorkflowIconGlyphNumber": 59511,
        "WFWorkflowIconStartColor": 4284869375
    }
}

try:
    # Write as binary plist to the Desktop
    with open(DESKTOP_PATH, 'wb') as f:
        plistlib.dump(shortcut_data, f, fmt=plistlib.FMT_BINARY)
    
    print(f"✅ Successfully created '{SHORTCUT_NAME}.shortcut' on your Desktop.")
    print("👉 Please double-click the file to import it into your Shortcuts app.")
except Exception as e:
    print(f"❌ Failed to create shortcut: {e}")
