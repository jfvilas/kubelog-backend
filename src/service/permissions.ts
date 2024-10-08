/*
Copyright 2024 Julio Fernandez

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import { LoggerService } from "@backstage/backend-plugin-api";
import { ClusterValidPods, PodData } from "@jfvilas/plugin-kubelog-common";
import { KubelogClusterData, KubelogPodPermissions, KubelogStaticData, PodPermissionRule } from "../model/KubelogStaticData";

export enum KWIRTH_SCOPE {
    filter=1,
    view,
    restart,
    api,
    cluster
}

const DEBUG=undefined
const debug = (a:any)  => {
    if (DEBUG) console.log(a);
}

const checkNamespaceAccess = (cluster:ClusterValidPods, podData:PodData, userEntityRef:string, userGroups:string[]):boolean => {
    var namespacePermissions=KubelogStaticData.clusterKubelogData.get(cluster.name)?.namespacePermissions;
    var allowedToNamespace=false;

    var rule=namespacePermissions?.find(ns => ns.namespace===podData.namespace);
    if (rule) {
        debug('CNA rule found '+rule.namespace)
        if (rule.identityRefs.includes(userEntityRef.toLowerCase())) {
            // a user ref has been found on a namespace rule
            allowedToNamespace=true;
        }
        else {
            var groupResult=rule.identityRefs.some(identityRef => userGroups.includes(identityRef));
            if (groupResult) {
                // a group ref match has been found
                allowedToNamespace=true;
            }
        }
    }
    else {
        // no restrictions for this namespace
        debug('CNA rule NOT found for '+podData.namespace)
        allowedToNamespace=true;
    }
    return allowedToNamespace;
}

//const checkPodPermissionRule = (ppr:PodPermissionRule, reqPod:PodData, entityName:string, userEntityRef:string, userGroups:string[]):boolean => {
const checkPodPermissionRule = (ppr:PodPermissionRule, entityName:string, userEntityRef:string, userGroups:string[]):boolean => {
    var refMatch:boolean=false;

    for (var podNameRegex of ppr.pods) {
        if (podNameRegex.test(entityName)) {
            for (var refRegex of ppr.refs) {
                // find userRef
                refMatch=refRegex.test(userEntityRef.toLowerCase());
                if (refMatch) {
                    break;
                }
                else {
                    // find group ref
                    refMatch = userGroups.some(g => refRegex.test(g));
                    if (refMatch) {
                        break;
                    }
                }
            }
        }
        else {
        }
        if (refMatch) break;
    }
    return refMatch;
}

const getPodPermissionSet = (reqScope:KWIRTH_SCOPE, cluster:KubelogClusterData) => {
    switch (reqScope) {
        case KWIRTH_SCOPE.view:
            return cluster.viewPermissions;
        case KWIRTH_SCOPE.restart:
            return cluster.restartPermissions;
    }
    return undefined
}
/**
 * This funciton checks permissions according to app-config rules (not kwirth rules), that is, namespace rules,
 * viewing rules and restarting rules
 * @param loggerSvc Backstage logger
 * @param reqCluster the cluster the pod belongs to
 * @param reqPod data about the pod the user wants to access
 * @param podPermissionSet a set of permission for the cluster (extracted from app-config)
 * @param entityName the name of the entity to search for
 * @param userEntityRef the canonical identity reference for the user ('type:namespace/ref')
 * @param userGroups ana array containing a list of groups the user belongs to
 * @returns booelan indicating if the user can access the pod for doing what scaope says (view or restart)
 */
const checkPodAccess = (loggerSvc:LoggerService, reqCluster:ClusterValidPods, reqPod:PodData, podPermissionSet:KubelogPodPermissions[], entityName:string, userEntityRef:string, userGroups:string[]):boolean => {
    var cluster = KubelogStaticData.clusterKubelogData.get(reqCluster.name);

    if (!cluster) {
        loggerSvc.warn(`Invalid cluster specified ${reqCluster.name}`);
        return false;
    }

    // we check all pod permissions until one of them evaluates to true (must be true on allow/except and false on deny/unless)

    // we use 'filter' here beacause a namespace can be specified more than once
    for (var podPermission of podPermissionSet.filter(pp => pp.namespace===reqPod.namespace)) {
        if (podPermission.allow) {
            
            // **** evaluate allow/except rules ****
            var allowMatches=false;
            var exceptMatches=false;
            // we test all allow rules, we stop if one matches
            for (var prr of podPermission.allow) {
                allowMatches = checkPodPermissionRule(prr, entityName, userEntityRef, userGroups);
            }
            if (allowMatches) {
                if (podPermission.except) {
                    // we test all except rules, will stop if found one that matches, no need to continue
                    for (var prr of podPermission.except) {
                        //exceptMatches = checkPodPermissionRule(prr, reqPod, entityName, userEntityRef, userGroups);
                        exceptMatches = checkPodPermissionRule(prr, entityName, userEntityRef, userGroups);
                        // if there is a exception the process finishes now for this podPermission)
                        if (exceptMatches) {
                            break;
                        }
                    }
                }
                else {
                }
            }

            if (allowMatches && !exceptMatches) {
                // **** evaluate deny/unless rules ****
                if (podPermission.deny) {
                    var denyMatches=false
                    var unlessMatches=false
                    for (var prr of podPermission.deny) {
                        //denyMatches = checkPodPermissionRule(prr, reqPod, entityName, userEntityRef, userGroups)
                        denyMatches = checkPodPermissionRule(prr, entityName, userEntityRef, userGroups)
                        if (denyMatches) {
                            break;
                        }
                    }
                    if (denyMatches && podPermission.unless) {
                        for (var prr of podPermission.unless) {
                            //unlessMatches = checkPodPermissionRule(prr, reqPod, entityName, userEntityRef, userGroups)
                            unlessMatches = checkPodPermissionRule(prr, entityName, userEntityRef, userGroups)
                            if (unlessMatches) {
                                break;
                            }
                        }
                    }
                    if (!denyMatches || (denyMatches && unlessMatches)) {
                        return true
                    }
                }
                else {
                    return true
                }
            }
            else {
                // do nothing, just continue podpermissionset loop
            }
        }
        else {
            // if no 'allow' is specified everybody has access
            // we continue loop checking other namespaces
            return true
        }
    }
    
    return false;
}

export { checkNamespaceAccess, checkPodAccess, getPodPermissionSet }