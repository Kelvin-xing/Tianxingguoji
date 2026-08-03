package tianxing.residency

import rego.v1

# Input contract:
# {"resources": [{"id", "sensitive", "region", "public_access", "replication_regions"}]}

deny contains violation if {
	some resource in object.get(input, "resources", [])
	resource.sensitive == true
	not resource.region
	violation := {
		"code": "MISSING_REGION",
		"resource_id": resource.id,
	}
}

deny contains violation if {
	some resource in object.get(input, "resources", [])
	resource.sensitive == true
	resource.region
	resource.region != "ap-east-1"
	violation := {
		"code": "NON_HK_REGION",
		"resource_id": resource.id,
	}
}

deny contains violation if {
	some resource in object.get(input, "resources", [])
	resource.sensitive == true
	object.get(resource, "public_access", false) == true
	violation := {
		"code": "PUBLIC_EXPOSURE",
		"resource_id": resource.id,
	}
}

deny contains violation if {
	some resource in object.get(input, "resources", [])
	resource.sensitive == true
	count(object.get(resource, "replication_regions", [])) > 0
	violation := {
		"code": "CROSS_REGION_REPLICATION",
		"resource_id": resource.id,
	}
}
