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
import { ClusterPods, PodData } from "@jfvilas/plugin-kubelog-common";
import { KubelogClusterData, KubelogStaticData, PodPermissionRule } from "../model/KubelogStaticData";

export enum KWIRTH_SCOPE {
    filter=1,
    view,
    restart,
    api,
    cluster
}

const checkNamespaceAccess = (cluster:ClusterPods, pod:PodData, userEntityRef:string, userGroups:string[]):boolean => {
    var namespacePermissions=KubelogStaticData.clusterKubelogData.get(cluster.name)?.namespacePermissions;
    var allowedToNamespace=false;

    var rule=namespacePermissions?.find(ns => ns.namespace===pod.namespace);
    if (rule) {
        console.log('nsaccess: apply rule: '+JSON.stringify(rule))
        if (rule.identityRefs.includes(userEntityRef.toLowerCase())) {
            // a user ref has been found on a namespace rule
            console.log('nsaccess: user match -> TRUE')
            allowedToNamespace=true;
        }
        else {
            var groupResult=rule.identityRefs.some(identityRef => userGroups.includes(identityRef));
            if (groupResult) {
                console.log('nsaccess: groupRef match --> TRUE')
                // a group ref match has been found
                allowedToNamespace=true;
            }
        }
    }
    else {
        // no restrictions for this namespace
        console.log('nsaccess: no retrictions found --> TRUE')
        allowedToNamespace=true;
    }
    return allowedToNamespace;
}

const checkPodPermissionRule = (ppr:PodPermissionRule, reqPod:PodData, entityName:string, userEntityRef:string, userGroups:string[]):boolean => {
    var refMatch:boolean=false;

    for (var podNameRegex of ppr.pods) {
        console.log(`  checking pod '${entityName}(${reqPod.name})' against pod regex ${podNameRegex.source}`);
        if (podNameRegex.test(entityName)) {
            for (var refRegex of ppr.refs) {
                console.log(`    checking ref ${userEntityRef} against ref regex ${refRegex.source}`);
                // find userRef
                refMatch=refRegex.test(userEntityRef.toLowerCase());
                if (refMatch) {
                    console.log(`    pod name '${entityName}(${reqPod.name})' matches '${podNameRegex.source}', identity '${userEntityRef.toLocaleLowerCase()}' matches user regex '${refRegex.source}'`)
                    break;
                }
                else {
                    // find group ref
                    refMatch = userGroups.some(g => refRegex.test(g));
                    if (refMatch) {
                        console.log(`    pod name '${entityName}(${reqPod.name})' matches '${podNameRegex.source}', identity '${userEntityRef.toLocaleLowerCase()}' matches group regex '${refRegex.source}'`)
                        break;
                    }
                }
            }
        }
        else {
            console.log('  no match')
        }
        if (refMatch) break;
    }
    if (!refMatch) console.log(`  pod '${entityName}(${reqPod.name})', identity '${userEntityRef.toLocaleLowerCase()}' have no match, returning false`)
    return refMatch;
}

const getPermissionSet = (reqScope:KWIRTH_SCOPE, cluster:KubelogClusterData) => {
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
 * @param reqScope the scope the user is requesting
 * @param reqCluster the cluster the pod belongs to
 * @param reqPod data about the pod the user wants to access
 * @returns booelan indicating if the user can access the pod for doing what scaope says (view or restart)
 */
const checkPodAccess = (loggerSvc:LoggerService, reqScope:KWIRTH_SCOPE, reqCluster:ClusterPods, reqPod:PodData, entityName:string, userEntityRef:string, userGroups:string[]):boolean => {
    console.log(`Checking reqScope '${KWIRTH_SCOPE[reqScope]}' scope in cluster ${reqCluster.name} for pod: ${reqPod.namespace+'/'+reqPod.name}`);
    var cluster = KubelogStaticData.clusterKubelogData.get(reqCluster.name);

    if (!cluster) {
        loggerSvc.warn(`Invalid cluster specified ${reqCluster.name}`);
        return false;
    }

    var podPermissions=getPermissionSet(reqScope, cluster);
    if (!podPermissions) {
        loggerSvc.warn(`Invalid scope requested: ${reqScope}`);
        return false;
    }

    // we check all pod permissions until one of them evaluates to true (must be true on allow/except and false on deny/unless)
    for (var podPermission of podPermissions.filter(pp => pp.namespace===reqPod.namespace)) {
        console.log(`testing pod ns: ${podPermission.namespace}`);
        if (podPermission.allow) {
            
            // **** evaluate allow/except rules ****
            var allowMatches=false;
            var exceptMatches=false;
            // we test all allow rules, we stop if one matches
            for (var prr of podPermission.allow) {
                console.log('check for allow')
                allowMatches = checkPodPermissionRule(prr, reqPod, entityName, userEntityRef, userGroups);
            }
            if (allowMatches) {
                console.log("ALLOW MATCHES");
                if (podPermission.except) {
                    console.log('check for except')
                    // we test all except rules, will stop if found one that matches, no need to continue
                    for (var prr of podPermission.except) {
                        exceptMatches = checkPodPermissionRule(prr, reqPod, entityName, userEntityRef, userGroups);
                        // if there is a exception the process finishes now for this podPermission)
                        if (exceptMatches) {
                            console.log("EXCEPT MATCHES");
                            break;
                        }
                    }
                }
                else {
                    console.log(`no 'except' specified`);
                }
            }

            if (allowMatches && !exceptMatches) {
                // **** evaluate deny/unless rules ****
                if (podPermission.deny) {
                    console.log('check for deny')
                    var denyMatches=false
                    var unlessMatches=false
                    for (var prr of podPermission.deny) {
                        denyMatches = checkPodPermissionRule(prr, reqPod, entityName, userEntityRef, userGroups)
                        if (denyMatches) {
                            console.log("DENY MATCHES");
                            break;
                        }
                    }
                    if (denyMatches && podPermission.unless) {
                        console.log('check for unless')
                        for (var prr of podPermission.unless) {
                            unlessMatches = checkPodPermissionRule(prr, reqPod, entityName, userEntityRef, userGroups)
                            if (unlessMatches) {
                                console.log("UNLESS MATCHES");
                                break;
                            }
                        }
                    }
                    if (!denyMatches || (denyMatches && unlessMatches)) {
                        console.log(`*** allow(${allowMatches}) except(${exceptMatches}) // deny (${denyMatches}) unless (${unlessMatches}): TRUE ***`)
                        return true
                    }
                }
                else {
                    console.log(`*** allow(${allowMatches}) except(${exceptMatches}) // not deny/unless: TRUE ***`)
                    return true
                }
            }
            else {
                // do nothing, just continue podpermissions loop
            }
        }
        else {
            // if no allow is specified everybody has access
        }
    }
    
    console.log(`FOUND NO VALID MATCH: FALSE`)
    return false;
}

export { checkNamespaceAccess, checkPodAccess, getPermissionSet }