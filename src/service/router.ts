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
import express from 'express';
import Router from 'express-promise-router';
import { AuthService, BackstageUserInfo, DiscoveryService, HttpAuthService, LoggerService, RootConfigService, UserInfoService } from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import { UserEntity } from '@backstage/catalog-model';
import { FetchApi } from '@backstage/core-plugin-api';

// Kubelog
import { ClusterPods } from '@jfvilas/plugin-kubelog-common';
import { loadClusters } from './config';
import { KubelogStaticData } from '../model/KubelogStaticData';
import { checkNamespaceAccess, checkPodAccess, KWIRTH_SCOPE } from './permissions';

export type KubelogRouterOptions = {
  discoverySvc: DiscoveryService;
  configSvc: RootConfigService;
  loggerSvc: LoggerService;
  userInfoSvc: UserInfoService;
  authSvc: AuthService;
  httpAuthSvc: HttpAuthService;
};

/**
 * 
 * @param options core services we need for kubelog to work
 * @returns an express Router
 */
async function createRouter(options: KubelogRouterOptions): Promise<express.Router> {
    const { configSvc, loggerSvc, userInfoSvc, authSvc, httpAuthSvc, discoverySvc } = options;

    loggerSvc.info('Loading static config');

    if (!configSvc.has('kubernetes.clusterLocatorMethods')) {
        loggerSvc.error(`Kueblog will not start, there is no 'clusterLocatorMethods' defined in app-config.`);
        throw new Error('Kueblog backend will not be available.');
    }

    try {
        loadClusters(loggerSvc, configSvc);
    }
    catch (err) {
        var txt=`Errors detected reading static configuration: ${err}`;
        loggerSvc.error(txt);
        throw new Error(txt);
    }

    loggerSvc.info('Static config loaded');
    if (configSvc.subscribe) {
        configSvc.subscribe( () => {
            try {
                loggerSvc.warn('Change detected on app-config, Kubelog will update config.');
                loadClusters(loggerSvc, configSvc);
            }
            catch(err) {
                loggerSvc.error(`Errors detected reading new configuration: ${err}`);
            }
        });
    }
    else {
        loggerSvc.info('Kubelog cannot subscribe to config changes.');
    }

    const router = Router();

    router.use(express.json());

    // we need this function to be able to invoke another backend plugin passing an authorization token
    const createAuthFetchApi = (token: string): FetchApi => {
        return {
            fetch: async (input, init) => {
                init = init || {};
                init.headers = {
                ...init.headers,
                Authorization: `Bearer ${token}`,
                };
                return fetch(input, init);
            }
        }
    }

    /**
     * Invokes Kwirth to obtain a list of pods that are tagged with the kubernetes-id of the entity we are looking for.
     * @param entityName name of the tagge dentity
     * @returns a ClusterPods[] (each ClusterPods is a cluster info with a list of pods).
     */
    const getValidClusters = async (entityName:string) => {
    var clusterList:ClusterPods[]=[];

    for (const name of KubelogStaticData.clusterKubelogData.keys()) {
        var url=KubelogStaticData.clusterKubelogData.get(name)?.home as string;
        var apiKey=KubelogStaticData.clusterKubelogData.get(name)?.apiKey;
        var title=KubelogStaticData.clusterKubelogData.get(name)?.title;
        var queryUrl=url+`/managecluster/find?label=backstage.io%2fkubernetes-id&entity=${entityName}`;
        try {
            var fetchResp = await fetch (queryUrl, {headers:{'Authorization':'Bearer '+apiKey}});
            var jsonResp=await fetchResp.json();
            if (jsonResp) clusterList.push({ name, url, title, data:jsonResp });
        }
        catch (err) {
            loggerSvc.warn(`Cannot access cluster ${name} (URL: ${queryUrl}): ${err}`);
        }
    }

    return clusterList;
    }

    /**
     * This function obtains an accesskey for streaming a concrete log in a specific pod
     * @param clusterName the name of the cluster
     * @param entityName the name of the Backstage entity we are streaming for
     * @param kwirthResource the Resource ID that identifies the log we want to stream
     * @param userName the name of the Backstage user (for logging purposes inside Kwirth)
     * @returns a Kwirth accessKey
     */
    const getAccessKey = async (clusterName:string, entityName:string, kwirthResource:string, userName:string) => {
        var url=KubelogStaticData.clusterKubelogData.get(clusterName)?.home as string;
        var apiKey=KubelogStaticData.clusterKubelogData.get(clusterName)?.apiKey;

        var payload={
            type:'volatile',
            resource: kwirthResource,
            description:`Backstage API key for user ${userName} accessing component ${entityName}`,
            expire:Date.now()+60*60*1000
        }
        var response=await fetch(url+'/key',{method:'POST', body:JSON.stringify(payload), headers:{'Content-Type':'application/json', Authorization:'Bearer '+apiKey}});
        var data=await response.json();
        return data.accessKey;
    }

    /**
     * Adds access keys to the list of kubernetes resources related with the entity. Only keys where the user is permitted are added.
     * @param foundClusters current list of clusters (whcih have no access keys yet)
     * @param entityName name of the entoty we want to stream logs
     * @param userEntityRef a user entoty ref for the current user ('user:group/id')
     * @param userGroups a list of the IAM groups the user belongs to
     * @returns the cluster list populated with access keys that the user is permitted to use
     */
    const addAccessKeys = async (scope:KWIRTH_SCOPE, foundClusters:ClusterPods[], entityName:string, userEntityRef:string, userGroups:string[]) => {
    var principal=userEntityRef.split(':')[1];
    var username=principal.split('/')[1];

    for (var cluster of foundClusters) {

        // for each pod we've found on the cluster we check all namespace permissions
        for (var pod of cluster.data) {
            var allowedToNamespace=checkNamespaceAccess(cluster, pod, userEntityRef, userGroups);

            if (allowedToNamespace) {
                // if the user fulfills any namespace permission, we now check pod permissions
                var allowedToPod=checkPodAccess(loggerSvc, scope, cluster, pod, userEntityRef, userGroups);
                if (allowedToPod) {
                    // now we ask for an accessKey for the specific scope (typically 'view' or 'restart')
                    var kwirthResource=`${KWIRTH_SCOPE[scope]}:${pod.namespace}::${pod.name}:`;
                    pod.accessKey=await getAccessKey(cluster.name, entityName, kwirthResource, username);          
                }
            }
            else {
                // user is not allowed to namespace, so no need to check pod permissions
            }
        }
    }
}

    /**
     * builds a list of groups (expressed as identity refs) that the user belongs to.
     * @param userInfo Backstage user info of the user to search groups for
     * @returns an array of group refs in canonical form
     */
    const getUserGroups = async (userInfo:BackstageUserInfo) => {
        const { token } = await authSvc.getPluginRequestToken({
            onBehalfOf: await authSvc.getOwnServiceCredentials(),
            targetPluginId: 'catalog'
        });
        const catalogClient = new CatalogClient({
            discoveryApi: discoverySvc,
            fetchApi: createAuthFetchApi(token),
        });

        const entity = await catalogClient.getEntityByRef(userInfo.userEntityRef) as UserEntity;
        var userGroupsRefs:string[]=[];
        if (entity?.spec.memberOf) userGroupsRefs=entity?.spec.memberOf;  
        return userGroupsRefs;
    }

    const processView = async (req:any, res:any) => {
        // obtain basic user info
        const credentials = await httpAuthSvc.credentials(req, { allow: ['user'] });
        const userInfo = await userInfoSvc.getUserInfo(credentials);
    
        // get user groups list
        var userGroupsRefs=await getUserGroups(userInfo);
        console.log('USER DATA');
        console.log(userInfo.userEntityRef);
        console.log(userGroupsRefs);
    
        // get a list of clusters that contain pods related to entity
        //+++ control error here (maybe we cannot conntact the cluster, for example)
        var foundClusters:ClusterPods[]=await getValidClusters(req.body.metadata.name);
    
        // add access keys to authorized resources (according to group memberships and kubelog config in app-config (namespace and pod permissions))
        await addAccessKeys(KWIRTH_SCOPE.view, foundClusters, req.body.metadata.name, userInfo.userEntityRef, userGroupsRefs);
    
        res.status(200).send(foundClusters);
    }

    const processRestart = async (req:any, res:any) => {
        console.log(req.body);
        res.status(401).send();
    }

    // this endpoints receives entity from the kubelog plugin and builds a list of resurces with api keys
    router.post(['/start','/view'], (req, res) => {
        //+++ warn only once
        loggerSvc.warn('Endpoint "/start" is deprecated, update your "plugin-kubelog" package to 0.9.0 or later before 2025-08-25.');
        processView(req,res);
    });
    router.post('/restart', processRestart);

    return router;
}

export { createRouter }
